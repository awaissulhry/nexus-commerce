import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { addDays } from '@nexus/factory-domain/safety/calendar/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedHealth, type HealthSeed } from '../../../../../../packages/factory-db/seed/health'
import { seed as seedParties } from '../../../../../../packages/factory-db/seed/parties'
import { seed as seedSafety, type SafetySeed } from '../../../../../../packages/factory-db/seed/safety'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { settleRequest } from '../../../platform/approvals-out/settle'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { systemContext } from '../../../platform/outbox/system'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * The risk assessment, the DVR (B-W2b-122; QHS-230, QHS-234) on the local stack: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the …_safety_w2b_guards triggers are real: a frozen version never
 * changes, a signature is append-only and signs the version's SHA-256, the certain date is the day of the last signature),
 * the real app. Tenant A from the factory-db seeds up to the health pages (company A's safety organisation; A1's DVR: v1 SIGNED
 * with its seal, v2 waiting for the RSPP and the doctor; four measures; role sheets; the incidents). The doctor's own
 * signature uses the harness's real sign-in (two-factor, step-up). Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/safety/risk`.
 */

let h: Harness
let app: FastifyInstance
let safety: SafetySeed
let health: HealthSeed

const NS = 'w2b122-risk'
const idOf = (key: string): string => seedUuid(NS, key)
const T = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), siteB1: idOf('site:B1'), actor: idOf('actor'), store: idOf('files:account:r2') }
const TENANT: TestTenant = { id: T.tenant, slug: NS, companies: [{ id: T.companyA, code: 'A' }, { id: T.companyB, code: 'B' }] }
const OFFICER_ID = newId()
const OFFICER: Permission[] = ['safety.view', 'safety.risk.manage', 'safety.risk.sign', 'safety.organisation.manage', 'files.read', 'files.upload']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  officer: { audience: 'office', tenantId: T.tenant, actorId: OFFICER_ID, grants: [grant(OFFICER)] },
  costs: { audience: 'office', tenantId: T.tenant, actorId: OFFICER_ID, grants: [grant([...OFFICER, 'money.cost'])] },
  viewer: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['safety.view'])] },
  // The seed's office actor: an owner of measures (it reads the safety pages through its roles), here with safety.view only.
  owner: { audience: 'office', tenantId: T.tenant, actorId: T.actor, grants: [grant(['safety.view'])] },
  companyB: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(OFFICER, [T.companyB])] },
  sales: { audience: 'office', tenantId: T.tenant, actorId: newId(), grants: [grant(['quotes.view'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let keys = 0
const key = () => `risk-${++keys}-${newId()}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<string[]> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json().error.issues ?? []).map((issue: Json) => String(issue.path))
}
const today = businessDate(new Date())
const eventsOf = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T.tenant, type])).map((row) => row.payload)

/** An AVAILABLE file of a record, written straight into the table (the files flow is tested in platform/files). */
async function fileOf(recordType: string, recordId: string, options: { companyId?: string; contentType?: string; sha256?: string } = {}): Promise<{ id: string; sha256: string }> {
  const id = newId()
  const companyId = options.companyId ?? T.companyA
  const sha256 = options.sha256 ?? createHash('sha256').update(id).digest('hex')
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, visibility, "availableAt")
     VALUES ($1, $2, $3, $4, $5, 'DOCUMENT', $6, $7, 100, $8, $9, $10, 'AVAILABLE', ARRAY['OFFICE']::"FileAudience"[], now())`,
    [id, T.tenant, companyId, recordType, recordId, `Made-up ${id.slice(-4)}.pdf`, options.contentType ?? 'application/pdf', sha256, T.store, `t/${T.tenant}/c/${companyId}/2026/${newId()}`],
  )
  return { id, sha256 }
}

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
let doctor: Person

async function asPerson(person: Person, method: 'GET' | 'POST', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await person.browser.send(method, url, body, { headers: { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('w2b122_risk')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  safety = await seedSafety({ db: h.database, namespace: NS })
  health = await seedHealth({ db: h.database, namespace: NS })
  // The system roles as the templates hold them now (safety.risk.* for the safety officer and the doctor).
  await h.database.withScope({ audience: 'office', tenantId: T.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'made-up-officer@example.test', 'Made-up Officer', 'ACTIVE')`, [OFFICER_ID, T.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // The occupational doctor of company A signs in to sign for their own role (their account's name is the appointee's).
  const user = await addUser(h, TENANT, { email: 'doctor.risk@example.com', role: 'safety_officer' })
  await admin(`UPDATE "User" SET "displayName" = 'Seed Occupational Doctor (made-up)' WHERE id = $1`, [user.id])
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if ((answer.body as Json)?.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  doctor = { id: user.id, browser, secret: await enrolTotp(h, browser) }
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('the assessments and the tiles (QHS-230)', () => {
  it('lists one row per site with its version in force, the one waiting, who signed, the open measures and the roles', async () => {
    const list = await ok('officer', 'GET', '/safety/risk/assessments')
    expect(list).toMatchObject({ canManage: true, law: 'D.Lgs. 81/2008 artt. 28-29', today })
    const a1 = list.assessments.find((row: Json) => row.id === safety.assessmentId)
    expect(a1).toMatchObject({ name: 'Plant A1', site: { code: expect.any(String) }, reviewState: 'PLANNED', openMeasures: 3, roles: 2, canManage: true })
    expect(a1.inForce).toMatchObject({ id: safety.versionIds.v1, label: 'v1', status: 'SIGNED', certainDateOn: addDays(today, -397) })
    expect(a1.waiting).toMatchObject({ id: safety.versionIds.v2, status: 'AWAITING_SIGNATURES' })
    expect(a1.waiting.signers).toEqual([
      { role: 'EMPLOYER', signedOn: addDays(today, -4) },
      { role: 'RSPP', signedOn: null },
      { role: 'RLS', signedOn: addDays(today, -3) },
      { role: 'DOCTOR', signedOn: null },
    ])
    expect((await ok('viewer', 'GET', '/safety/risk/assessments')).canManage).toBe(false)
    expect((await ok('companyB', 'GET', '/safety/risk/assessments')).assessments).toEqual([])
    expect((await call('sales', 'GET', '/safety/risk/assessments')).statusCode).toBe(403)

    const counts = await ok('officer', 'GET', '/safety/risk/counts')
    expect(counts).toMatchObject({ signaturesMissing: 2, assessments: 1, withoutVersion: 0, measuresOverdue: 0, today })
    expect(counts.measuresDueSoon).toBeGreaterThanOrEqual(1)
    expect(counts.reviewsDue).toBe(0)
  })

  it('opens the record: every version with its seal and signers, who would sign today, the plan and its burn-down', async () => {
    const record = await ok('viewer', 'GET', `/safety/risk/assessments/${safety.assessmentId}`)
    expect(record.versions.map((version: Json) => version.label)).toEqual(['v2', 'v1'])
    const [v2, v1] = record.versions
    expect(v1).toMatchObject({ inForce: true, superseded: false, status: 'SIGNED', sealed: { version: 1, language: 'it' }, missing: [] })
    expect(v2).toMatchObject({ inForce: false, status: 'AWAITING_SIGNATURES', missing: ['RSPP', 'DOCTOR'], file: { contentType: 'application/pdf' }, frozenBy: expect.any(String) })
    expect(v2.sha256).toMatch(/^[0-9a-f]{64}$/)
    const rls = v2.signers.find((signer: Json) => signer.role === 'RLS')
    // The RLS signed with badge and PIN on the office's tablet: no office user recorded it.
    expect(rls.signature).toMatchObject({ method: 'FLOOR_PIN', signerName: 'Seed Employee Two', recordedBy: null })
    expect(v2.signers.find((signer: Json) => signer.role === 'DOCTOR')).toMatchObject({ holder: { appointmentId: safety.appointmentIds.doctor, name: 'Seed Occupational Doctor (made-up)' }, signature: null, mine: false })
    expect(record.next.signers.map((signer: Json) => signer.role)).toEqual(['EMPLOYER', 'RSPP', 'RLS', 'DOCTOR'])
    expect(record.next).toMatchObject({ sameAs: [], missingEmployer: false })
    expect(record.plan).toMatchObject({ open: 3, verified: 1, cancelled: 0 })
    expect(record.plan.burn).toHaveLength(53)
    expect(record.plan.burn.at(-1)).toEqual({ on: today, open: 3 })
    expect(record).toMatchObject({ may: { manage: false, sign: false }, law: { dvr: 'D.Lgs. 81/2008 artt. 28-29', versions: 'D.Lgs. 81/2008 art. 28 c.2', plan: 'D.Lgs. 81/2008 art. 28 c.2 c-d', review: 'D.Lgs. 81/2008 art. 29 c.3' } })
    expect((await call('companyB', 'GET', `/safety/risk/assessments/${safety.assessmentId}`)).statusCode).toBe(404)
  })

  it('adds an assessment per site or production unit, refusing a site of another company and a name taken', async () => {
    expect(await no('officer', 'POST', '/safety/risk/assessments', { companyId: T.companyA, siteId: T.siteB1, name: 'Wrong' }, 409)).toEqual(['refusal/SITE_OTHER_COMPANY', 'body/siteId'])
    expect(await no('officer', 'POST', '/safety/risk/assessments', { companyId: T.companyA, siteId: T.siteA1, name: 'plant a1' }, 409)).toEqual(['refusal/NAME_TAKEN', 'body/name'])
    expect(await no('officer', 'POST', '/safety/risk/assessments', { companyId: T.companyA, siteId: T.siteA1, name: 'Unit', nextReviewOn: addDays(today, 4000) }, 409)).toContain('refusal/DUE_TOO_FAR')
    expect((await call('viewer', 'POST', '/safety/risk/assessments', { companyId: T.companyA, siteId: T.siteA1, name: 'Cutting hall' })).statusCode).toBe(403)
    const added = (await ok('officer', 'POST', '/safety/risk/assessments', { companyId: T.companyA, siteId: T.siteA1, name: 'Cutting hall (made-up)', nextReviewOn: addDays(today, 20) }, 201)).assessment
    expect(added).toMatchObject({ status: 'ACTIVE', reviewState: 'DUE_SOON', inForce: null, waiting: null, openMeasures: 0 })
    const edited = (await ok('officer', 'PATCH', `/safety/risk/assessments/${added.id}`, { version: added.version, nextReviewOn: addDays(today, -1), note: 'Made-up note.' })).assessment
    expect(edited).toMatchObject({ reviewState: 'OVERDUE', note: 'Made-up note.' })
    expect((await call('officer', 'PATCH', `/safety/risk/assessments/${added.id}`, { version: added.version, note: 'stale' })).statusCode).toBe(409)
    expect((await ok('officer', 'GET', '/safety/risk/counts')).withoutVersion).toBe(1)
    expect((await eventsOf('risk_assessment.changed')).map((event) => event.change)).toEqual(['ADDED', 'EDITED'])
  })
})

describe('a version is signed by its four signers; the certain date is the last signature (QHS-230)', () => {
  it('refuses a paper signature that is not the holder’s, dated outside the window, or without its scan', async () => {
    const v2 = safety.versionIds.v2
    const url = `/safety/risk/versions/${v2}/signatures`
    const base = { role: 'RSPP', signerName: 'Seed Safety Consultancy (made-up)', signedOn: addDays(today, -1) }
    expect(await no('officer', 'POST', url, { ...base, role: 'RLST' }, 409)).toEqual(['refusal/NOT_A_SIGNER', 'body/role'])
    expect(await no('officer', 'POST', url, { ...base, role: 'EMPLOYER', signerName: 'Seed Legal Representative (made-up)' }, 409)).toEqual(['refusal/SIGNED_ALREADY', 'body/role'])
    expect(await no('officer', 'POST', url, { ...base, signedOn: addDays(today, 1) }, 409)).toEqual(['refusal/SIGNED_IN_FUTURE', 'body/signedOn'])
    expect(await no('officer', 'POST', url, { ...base, signedOn: addDays(today, -6) }, 409)).toEqual(['refusal/SIGNED_BEFORE_FROZEN', 'body/signedOn'])
    expect(await no('officer', 'POST', url, { ...base, signerName: 'Somebody Else' }, 409)).toEqual(['refusal/NAME_MISMATCH', 'body/signerName'])
    expect(await no('officer', 'POST', url, { ...base, appointmentId: safety.appointmentIds.doctor }, 409)).toEqual(['refusal/NO_APPOINTMENT', 'body/appointmentId'])
    expect(await no('officer', 'POST', url, base, 409)).toEqual(['refusal/SCAN_MISSING'])
    expect((await call('viewer', 'POST', url, base)).statusCode).toBe(403)
  })

  it('records the RSPP’s signed paper with its scan filed first as a file of the signature', async () => {
    const v2 = safety.versionIds.v2
    const record = await ok('officer', 'GET', `/safety/risk/assessments/${safety.assessmentId}`)
    const rspp = record.versions[0].signers.find((signer: Json) => signer.role === 'RSPP')
    const scan = await fileOf('RiskAssessmentSignature', rspp.signatureId)
    const answer = await ok('officer', 'POST', `/safety/risk/versions/${v2}/signatures`, { role: 'RSPP', signerName: 'seed safety consultancy (made-up)', signedOn: addDays(today, -1) }, 201)
    expect(answer).toMatchObject({ complete: false, sealed: false, version: { status: 'AWAITING_SIGNATURES', missing: ['DOCTOR'] } })
    expect(answer.version.signers.find((signer: Json) => signer.role === 'RSPP')).toMatchObject({ signatureId: rspp.signatureId, signature: { id: rspp.signatureId, method: 'PAPER', signedOn: addDays(today, -1), recordedBy: 'Made-up Officer', scan: { fileId: scan.id } } })
    const [row] = await admin(`SELECT key, "signatureSha256" AS sha, "appointmentId" FROM "RiskAssessmentSignature" WHERE id = $1`, [rspp.signatureId])
    expect(row).toEqual({ key: `signature:${v2}:RSPP`, sha: record.versions[0].sha256, appointmentId: safety.appointmentIds.rspp })
    expect(await eventsOf('risk_signature.collected')).toContainEqual({ assessmentId: safety.assessmentId, versionId: v2, role: 'RSPP', method: 'PAPER', complete: false })
  })

  it('takes the doctor’s own signature in the office, after a fresh code; the last one makes it SIGNED and keeps its seal', async () => {
    const v2 = safety.versionIds.v2
    const url = `/safety/risk/versions/${v2}/sign`
    // Somebody else holding safety.risk.sign is not the doctor: refused before any code is asked.
    expect(await no('officer', 'POST', url, { role: 'DOCTOR', signerName: 'Seed Occupational Doctor (made-up)' }, 409)).toEqual(['refusal/NOT_THE_SIGNER'])
    const before = await asPerson(doctor, 'GET', `/safety/risk/assessments/${safety.assessmentId}`, undefined, 200)
    expect(before.versions[0].signers.find((signer: Json) => signer.role === 'DOCTOR').mine).toBe(true)
    expect((await asPerson(doctor, 'POST', url, { role: 'DOCTOR', signerName: 'Another Name' }, 409)).error.issues[0].path).toBe('refusal/NAME_MISMATCH')
    expect((await asPerson(doctor, 'POST', url, { role: 'DOCTOR', signerName: 'Seed Occupational Doctor (made-up)' }, 403)).error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, doctor.browser, doctor.secret)
    const signed = await asPerson(doctor, 'POST', url, { role: 'DOCTOR', signerName: 'Seed Occupational Doctor (made-up)' }, 200)
    expect(signed).toMatchObject({ complete: true, sealed: true, version: { status: 'SIGNED', certainDateOn: today, inForce: true, missing: [], sealed: { version: 1, language: 'it' } } })
    expect(signed.version.signers.find((signer: Json) => signer.role === 'DOCTOR').signature).toMatchObject({ method: 'OFFICE', signedOn: today, recordedBy: 'Seed Occupational Doctor (made-up)' })
    // The seal is a GeneratedDocument DVR_FROZEN of the version with its file (office only); the consultant's PDF is not copied.
    const [seal] = await admin(`SELECT g."siteId", f."recordType", f."contentType", f.status::text AS status, f.visibility::text[] AS visibility FROM "GeneratedDocument" g JOIN "StoredFile" f ON f.id = g."fileId" WHERE g."recordId" = $1 AND g.kind = 'DVR_FROZEN'`, [v2])
    expect(seal).toEqual({ siteId: T.siteA1, recordType: 'RiskAssessmentVersion', contentType: 'application/pdf', status: 'AVAILABLE', visibility: ['OFFICE'] })
    expect((await eventsOf('risk_assessment_version.changed')).filter((event) => event.versionId === v2).map((event) => event.change)).toEqual(['SIGNED', 'SEALED'])
    // v1 is superseded and stays; a signed version takes no more signatures and is never withdrawn.
    const record = await ok('officer', 'GET', `/safety/risk/assessments/${safety.assessmentId}`)
    expect(record.versions.map((version: Json) => [version.label, version.inForce, version.superseded])).toEqual([
      ['v2', true, false],
      ['v1', false, true],
    ])
    expect(await no('officer', 'POST', `/safety/risk/versions/${v2}/signatures`, { role: 'DOCTOR', signerName: 'Seed Occupational Doctor (made-up)', signedOn: today }, 409)).toContain('refusal/NOT_AWAITING')
    expect(await no('officer', 'POST', `/safety/risk/versions/${v2}/withdraw`, { version: signed.version.version, reason: 'Made-up' }, 409)).toContain('refusal/NOT_AWAITING')
    // Keeping the seal again gives the same one; the preview is a PDF.
    expect(await ok('officer', 'POST', `/safety/risk/versions/${v2}/seal`, { language: 'it' }, 201)).toMatchObject({ made: false, document: { version: 1 } })
    expect(await ok('officer', 'POST', `/safety/risk/versions/${v2}/seal`, { language: 'en' }, 201)).toMatchObject({ made: true, document: { version: 2, language: 'en' } })
    const preview = await call('viewer', 'GET', `/safety/risk/versions/${v2}/seal?language=en`)
    expect(preview.statusCode).toBe(200)
    expect(preview.headers['content-type']).toContain('application/pdf')
    expect(preview.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await call('viewer', 'POST', `/safety/risk/versions/${v2}/seal`, {})).statusCode).toBe(403)
  })

  it('freezes a new version of the consultant’s PDF with its SHA-256, refusing what is not a new PDF of this assessment', async () => {
    const url = `/safety/risk/assessments/${safety.assessmentId}/versions`
    const base = { label: 'v3', effectiveOn: addDays(today, 7), authorKind: 'CONSULTANT', authorName: 'Seed Safety Consultancy (made-up)', changeSummary: 'The new cutting hall (made-up).' }
    const other = await fileOf('SafetyDeadline', newId())
    expect(await no('officer', 'POST', url, { ...base, fileId: other.id }, 409)).toEqual(['refusal/FILE_NOT_READY', 'body/fileId'])
    const png = await fileOf('RiskAssessment', safety.assessmentId, { contentType: 'image/png' })
    expect(await no('officer', 'POST', url, { ...base, fileId: png.id }, 409)).toEqual(['refusal/NOT_PDF', 'body/fileId'])
    const v2 = (await ok('officer', 'GET', `/safety/risk/assessments/${safety.assessmentId}`)).versions[0]
    const again = await fileOf('RiskAssessment', safety.assessmentId, { sha256: v2.sha256 })
    expect(await no('officer', 'POST', url, { ...base, fileId: again.id }, 409)).toEqual(['refusal/FROZEN_ALREADY', 'body/fileId'])
    expect(await no('officer', 'POST', url, { ...base, label: ' ', fileId: again.id }, 400)).toEqual(['body/label'])
    const pdf = await fileOf('RiskAssessment', safety.assessmentId)
    const frozen = (await ok('officer', 'POST', url, { ...base, fileId: pdf.id }, 201)).version
    expect(frozen).toMatchObject({ versionNo: 3, label: 'v3', status: 'AWAITING_SIGNATURES', sha256: pdf.sha256, frozenBy: 'Made-up Officer', missing: ['EMPLOYER', 'RSPP', 'RLS', 'DOCTOR'], file: { fileId: pdf.id } })
    // One version waits at a time.
    const next = await fileOf('RiskAssessment', safety.assessmentId)
    expect(await no('officer', 'POST', url, { ...base, label: 'v4', fileId: next.id }, 409)).toContain('refusal/VERSION_WAITING')
    // The database holds the freeze for every login: the PDF and its SHA-256 never change.
    await expect(admin(`UPDATE "RiskAssessmentVersion" SET sha256 = $2 WHERE id = $1`, [frozen.id, 'b'.repeat(64)])).rejects.toThrow(/frozen/)
    expect((await eventsOf('risk_assessment_version.changed')).some((event) => event.versionId === frozen.id && event.change === 'FROZEN')).toBe(true)
  })

  it('never lets one person sign a version twice, and withdraws a version still waiting with the reason', async () => {
    const v3 = (await ok('officer', 'GET', `/safety/risk/assessments/${safety.assessmentId}`)).versions[0]
    const url = `/safety/risk/versions/${v3.id}/signatures`
    const employer = v3.signers.find((signer: Json) => signer.role === 'EMPLOYER')
    await fileOf('RiskAssessmentSignature', employer.signatureId)
    await ok('officer', 'POST', url, { role: 'EMPLOYER', signerName: 'Seed Legal Representative (made-up)', signedOn: today }, 201)
    // The employer's legal representative is appointed occupational doctor too (made-up): they signed already.
    const appointed = (await ok('officer', 'POST', '/safety/appointments', { companyId: T.companyA, role: 'DOCTOR', outsideName: 'Seed Legal Representative (made-up)', fromDate: today }, 201)).appointment
    const doctorSignature = v3.signers.find((signer: Json) => signer.role === 'DOCTOR')
    await fileOf('RiskAssessmentSignature', doctorSignature.signatureId)
    expect(await no('officer', 'POST', url, { role: 'DOCTOR', signerName: 'Seed Legal Representative (made-up)', signedOn: today, appointmentId: appointed.id }, 409)).toEqual(['refusal/SAME_PERSON'])
    expect(await no('officer', 'POST', `/safety/risk/versions/${v3.id}/withdraw`, { version: v3.version, reason: ' ' }, 400)).toContain('body/reason')
    const withdrawn = (await ok('officer', 'POST', `/safety/risk/versions/${v3.id}/withdraw`, { version: v3.version, reason: 'The consultant sent the wrong file (made-up).' })).version
    expect(withdrawn).toMatchObject({ status: 'WITHDRAWN', withdrawnReason: 'The consultant sent the wrong file (made-up).', missing: [] })
    // Its signature stays (append-only); the doctor's own signing view offers it no more.
    expect((await admin(`SELECT count(*)::int AS n FROM "RiskAssessmentSignature" WHERE "versionId" = $1`, [v3.id]))[0]!.n).toBe(1)
    expect(await no('officer', 'POST', url, { role: 'RSPP', signerName: 'Seed Safety Consultancy (made-up)', signedOn: today }, 409)).toContain('refusal/NOT_AWAITING')
  })

  it('asks the organisation for an employer before freezing, and signs a person holding two roles once', async () => {
    const assessment = (await ok('officer', 'POST', '/safety/risk/assessments', { companyId: T.companyB, siteId: T.siteB1, name: 'Plant B1 (made-up)' }, 201)).assessment
    const url = `/safety/risk/assessments/${assessment.id}/versions`
    const base = { label: 'v1', effectiveOn: today, authorKind: 'IN_HOUSE', authorName: 'Made-up Owner B' }
    const pdf = await fileOf('RiskAssessment', assessment.id, { companyId: T.companyB })
    expect(await no('officer', 'POST', url, { ...base, fileId: pdf.id }, 409)).toEqual(['refusal/NO_EMPLOYER'])
    for (const role of ['EMPLOYER', 'RSPP']) await ok('officer', 'POST', '/safety/appointments', { companyId: T.companyB, role, outsideName: 'Made-up Owner B', fromDate: today }, 201)
    const record = await ok('officer', 'GET', `/safety/risk/assessments/${assessment.id}`)
    expect(record.next).toMatchObject({ signers: [{ role: 'EMPLOYER' }, { role: 'RLST' }], sameAs: [{ role: 'RSPP', as: 'EMPLOYER', name: 'Made-up Owner B' }], missingEmployer: false })
    const frozen = (await ok('officer', 'POST', url, { ...base, fileId: pdf.id }, 201)).version
    expect(frozen.signers.map((signer: Json) => signer.role)).toEqual(['EMPLOYER', 'RLST'])
  })
})

describe('an outside signer signs by link (B-W2b-F13b on the wave-23 schema; AP1:02, SafetySignMethod LINK)', () => {
  it('a refused answer writes no signature; an approved one is the LINK signature, and the last makes the version SIGNED', async () => {
    await seedParties({ db: h.database, namespace: NS })
    const party = idOf('party:P1')
    const assessmentId = (await ok('officer', 'GET', '/safety/risk/assessments')).assessments.find((row: Json) => row.name === 'Plant B1 (made-up)').id
    const version = (await ok('officer', 'GET', `/safety/risk/assessments/${assessmentId}`)).versions[0]
    expect(version).toMatchObject({ status: 'AWAITING_SIGNATURES', missing: ['EMPLOYER', 'RLST'] })
    // The territorial RLS is an outside contact of a party (made-up), appointed today: the approval request goes to that party.
    const rlst = (await ok('officer', 'POST', '/safety/appointments', { companyId: T.companyB, role: 'RLST', outsideName: 'Made-up Territorial RLS', outsidePartyId: party, fromDate: today }, 201)).appointment
    // An answered SIGNATURE request as platform/approvals-out leaves it (its own flow is tested there): written straight into
    // the table, its guard set aside for this one insert.
    const answered = async (status: 'APPROVED' | 'REFUSED', typedName: string): Promise<string> => {
      const id = newId()
      await admin(`ALTER TABLE "ApprovalRequest" DISABLE TRIGGER USER`)
      try {
        await admin(
          `INSERT INTO "ApprovalRequest" (id, "tenantId", "companyId", "recordType", "recordId", "partyId", kind, question, "dueAt", status, answer, "typedName", "answeredAt")
           VALUES ($1, $2, $3, 'RiskAssessmentVersion', $4, $5, 'SIGNATURE', 'Sign the new version (made-up).', now() + interval '5 days', $6::"ApprovalStatus", $7, $8, now())`,
          [id, T.tenant, T.companyB, version.id, party, status, status === 'REFUSED' ? 'Not this version (made-up).' : null, typedName],
        )
      } finally {
        await admin(`ALTER TABLE "ApprovalRequest" ENABLE TRIGGER USER`)
      }
      return id
    }
    const system = () => callerFor(h.database, systemContext(T.tenant, newId()))
    const linkAudits = () => admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.signatureByLink' ORDER BY at, id`, [version.id])

    // REFUSED: a refusal signs nothing; the version's history says why.
    const refused = await answered('REFUSED', 'Made-up Territorial RLS')
    expect((await settleRequest(system(), refused, h.clock)).settled).toBe(true)
    expect(await admin(`SELECT id FROM "RiskAssessmentSignature" WHERE "versionId" = $1`, [version.id])).toEqual([])
    expect((await linkAudits()).map((row) => row.after)).toEqual([expect.objectContaining({ role: 'RLST', signatureWritten: false, why: 'NOT_APPROVED', approvalRequestId: refused })])

    // The employer signs on paper (its scan filed first); then the RLST's approval by link is the last signature.
    const employer = version.signers.find((signer: Json) => signer.role === 'EMPLOYER')
    await fileOf('RiskAssessmentSignature', employer.signatureId, { companyId: T.companyB })
    await ok('officer', 'POST', `/safety/risk/versions/${version.id}/signatures`, { role: 'EMPLOYER', signerName: 'Made-up Owner B', signedOn: today }, 201)
    const approved = await answered('APPROVED', '  Made-up Territorial RLS ')
    expect((await settleRequest(system(), approved, h.clock)).settled).toBe(true)
    const [row] = await admin(`SELECT method::text AS method, "approvalRequestId", "appointmentId", "signerName", "signedOn"::text AS "signedOn", "signedById", key FROM "RiskAssessmentSignature" WHERE "versionId" = $1 AND role = 'RLST'`, [version.id])
    expect(row).toEqual({ method: 'LINK', approvalRequestId: approved, appointmentId: rlst.id, signerName: 'Made-up Territorial RLS', signedOn: today, signedById: null, key: `signature:${version.id}:RLST` })
    const signed = (await ok('officer', 'GET', `/safety/risk/assessments/${assessmentId}`)).versions[0]
    expect(signed).toMatchObject({ status: 'SIGNED', certainDateOn: today, missing: [] })
    expect(signed.signers.find((signer: Json) => signer.role === 'RLST').signature).toMatchObject({ method: 'LINK', signerName: 'Made-up Territorial RLS', recordedBy: null, appointmentId: rlst.id })
    expect(await eventsOf('risk_signature.collected')).toContainEqual({ assessmentId, versionId: version.id, role: 'RLST', method: 'LINK', complete: true })
    // (The settle runs on the harness clock, the freeze on the real one: their events' order is not the test's.)
    expect((await eventsOf('risk_assessment_version.changed')).filter((event) => event.versionId === version.id).map((event) => event.change).sort()).toEqual(['FROZEN', 'SIGNED'])
    expect((await linkAudits()).at(-1)!.after).toMatchObject({ signatureWritten: true, method: 'LINK', role: 'RLST' })
    // The seal names how it was signed (kept by the office afterwards: no file store in the settle).
    expect(signed.sealed).toBeNull()
    const preview = await call('officer', 'GET', `/safety/risk/versions/${version.id}/seal?language=en`)
    expect(preview.statusCode, preview.body.slice(0, 200)).toBe(200)
    expect(preview.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    // A settle again replays (its idempotency key): still one signature; a version no longer waiting takes none by link.
    await settleRequest(system(), approved, h.clock)
    expect(await admin(`SELECT role::text AS role, method::text AS method FROM "RiskAssessmentSignature" WHERE "versionId" = $1 ORDER BY role`, [version.id])).toEqual([
      { role: 'EMPLOYER', method: 'PAPER' },
      { role: 'RLST', method: 'LINK' },
    ])
    const late = await answered('APPROVED', 'Made-up Territorial RLS')
    await settleRequest(system(), late, h.clock)
    expect((await linkAudits()).at(-1)!.after).toMatchObject({ signatureWritten: false, why: 'VERSION_NOT_WAITING' })
  })
})

describe('the improvement plan (QHS-234)', () => {
  let measureId = ''
  it('adds a measure with its owner, due day, roles and cost (the cost grain only), and refuses what does not fit', async () => {
    const base = { assessmentId: safety.assessmentId, title: 'Hearing protection signs at the press (made-up)', risk: 'Noise at the clicking press', roleSheetIds: [safety.roleSheetIds.cutter], ownerId: T.actor, dueOn: addDays(today, -2), source: 'DVR' }
    expect((await call('officer', 'POST', '/safety/risk/measures', { ...base, cost: 12000 })).statusCode).toBe(403)
    expect(await no('costs', 'POST', '/safety/risk/measures', { ...base, roleSheetIds: [safety.roleSheetIds.machinistB] }, 409)).toEqual(['refusal/ROLE_SHEET_OTHER_SITE', 'body/roleSheetIds'])
    expect(await no('costs', 'POST', '/safety/risk/measures', { ...base, ownerId: newId() }, 409)).toEqual(['refusal/OWNER_NOT_ALLOWED', 'body/ownerId'])
    expect(await no('costs', 'POST', '/safety/risk/measures', { ...base, source: 'INCIDENT', sourceRecordType: 'Incident', sourceRecordId: health.incidentIds.b1NearMiss }, 409)).toEqual(['refusal/SOURCE_NOT_FOUND', 'body/sourceRecordId'])
    expect(await no('costs', 'POST', '/safety/risk/measures', { ...base, source: 'INCIDENT' }, 400)).toEqual(['body/sourceRecordId'])
    expect(await no('costs', 'POST', '/safety/risk/measures', { ...base, versionId: safety.versionIds.v1, cost: -1 }, 400)).toContain('body/cost')
    expect((await call('viewer', 'POST', '/safety/risk/measures', base)).statusCode).toBe(403)
    const owners = (await ok('officer', 'GET', `/safety/risk/owners?companyId=${T.companyA}`)).owners
    expect(owners.map((owner: Json) => owner.id)).toContain(T.actor)

    const added = (await ok('costs', 'POST', '/safety/risk/measures', { ...base, cost: 12000 }, 201)).measure
    measureId = added.id
    // The DVR source defaults to the version in force (v2, signed above).
    expect(added).toMatchObject({ status: 'PLANNED', dueState: 'OVERDUE', cost: 12000, currency: 'EUR', source: 'DVR', sourceVersion: { id: safety.versionIds.v2, label: 'v2' }, roleSheets: [{ id: safety.roleSheetIds.cutter, code: 'CUT' }], ownerId: T.actor, canManage: true })
    // Without the cost grain the cost is not in the answer at all.
    const seen = (await ok('officer', 'GET', `/safety/risk/measures/${added.id}`)).measure
    expect('cost' in seen).toBe(false)
    const fromIncident = (await ok('officer', 'POST', '/safety/risk/measures', { assessmentId: safety.assessmentId, title: 'Blade guard check (made-up)', source: 'INCIDENT', sourceRecordType: 'Incident', sourceRecordId: health.incidentIds.cut }, 201)).measure
    expect(fromIncident).toMatchObject({ source: 'INCIDENT', sourceRecord: { type: 'Incident', id: health.incidentIds.cut }, sourceVersion: null, dueState: null })
    const [audit] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'safety.addMeasure'`, [added.id])
    expect(audit!.after).toMatchObject({ cost: { $money: 'cost', value: 12000 } })
    expect((await ok('officer', 'GET', '/safety/risk/counts')).measuresOverdue).toBe(1)
  })

  it('is moved along by its owner, verified or cancelled by a manager, and keeps only its note once final', async () => {
    const read = async () => (await ok('officer', 'GET', `/safety/risk/measures/${measureId}`)).measure
    let measure = await read()
    expect((await ok('owner', 'GET', `/safety/risk/measures?view=mine`)).measures.map((row: Json) => row.id)).toContain(measureId)
    expect((await ok('owner', 'GET', `/safety/risk/measures/${measureId}`)).measure.canMove).toEqual(['IN_PROGRESS', 'DONE'])
    expect((await call('viewer', 'POST', `/safety/risk/measures/${measureId}/status`, { version: measure.version, status: 'IN_PROGRESS' })).statusCode).toBe(403)
    expect(await no('officer', 'POST', `/safety/risk/measures/${measureId}/status`, { version: measure.version, status: 'VERIFIED' }, 409)).toEqual(['refusal/BAD_MOVE', 'body/status'])
    measure = (await ok('owner', 'POST', `/safety/risk/measures/${measureId}/status`, { version: measure.version, status: 'IN_PROGRESS' })).measure
    measure = (await ok('owner', 'POST', `/safety/risk/measures/${measureId}/status`, { version: measure.version, status: 'DONE', evidenceNote: 'Signs fitted on both sides (made-up).' })).measure
    expect(measure).toMatchObject({ status: 'DONE', dueState: 'DONE', doneBy: expect.any(String), evidenceNote: 'Signs fitted on both sides (made-up).' })
    expect((await call('owner', 'POST', `/safety/risk/measures/${measureId}/status`, { version: measure.version, status: 'VERIFIED' })).statusCode).toBe(403)
    measure = (await ok('officer', 'POST', `/safety/risk/measures/${measureId}/status`, { version: measure.version, status: 'VERIFIED' })).measure
    expect(measure).toMatchObject({ status: 'VERIFIED', verifiedBy: 'Made-up Officer', canMove: [] })
    expect(await no('officer', 'PATCH', `/safety/risk/measures/${measureId}`, { version: measure.version, dueOn: today }, 409)).toContain('refusal/MEASURE_FINAL')
    expect((await ok('officer', 'PATCH', `/safety/risk/measures/${measureId}`, { version: measure.version, note: 'Checked at the meeting (made-up).' })).measure.note).toBe('Checked at the meeting (made-up).')

    const other = (await ok('officer', 'GET', '/safety/risk/measures?view=open')).measures.find((row: Json) => row.title === 'Blade guard check (made-up)')
    expect(await no('officer', 'POST', `/safety/risk/measures/${other.id}/status`, { version: other.version, status: 'CANCELLED' }, 400)).toEqual(['body/reason'])
    const cancelled = (await ok('officer', 'POST', `/safety/risk/measures/${other.id}/status`, { version: other.version, status: 'CANCELLED', reason: 'Merged into the guard measure (made-up).' })).measure
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Merged into the guard measure (made-up).' })
    expect((await ok('officer', 'GET', '/safety/risk/measures?view=done')).measures.map((row: Json) => row.id)).toContain(measureId)
    expect((await ok('officer', 'GET', `/safety/risk/measures?view=all&assessmentId=${safety.assessmentId}`)).measures.length).toBe(6)
    expect((await eventsOf('risk_measure.changed')).filter((event) => event.measureId === measureId).map((event) => `${event.change}:${event.status}`)).toEqual(['ADDED:PLANNED', 'MOVED:IN_PROGRESS', 'MOVED:DONE', 'MOVED:VERIFIED', 'EDITED:VERIFIED'])
  })
})
