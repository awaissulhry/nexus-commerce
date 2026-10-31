import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { runAlertEvaluation } from '../../../platform/alerts/engine'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { storeGeneratedFile } from '../../../platform/files/files'
import { fireDueTimers } from '../../../platform/timers/fire'
import { pdfRetainUntil, useCertificatesClock } from '../certificates/certificates'
import { garmentLabelFor } from '../labels/preview'
import { runRenewalStages } from './stages'

/**
 * Certificate renewals and changes to an approved type (B-W2a-66; QHS-105, PRD-283, PRD-285; Reg. (EU) 2016/425 Annex V
 * 7.2) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security
 * and the …_product_guards and …_supply_w2a_guards triggers are real), the factory-db seeds up to the compliance seed
 * (the brand-held certificate SEED-CERT-0001 covering the jacket SEED-JKT-01, its draft revision 1 with BOM, routing and
 * label), people with live role assignments (the renewal task's assignee is checked against them) and test sessions with
 * the same template grants. The BOM's release, the alert engine, the timers and the stage pass run as the API and the
 * scheduler would. Everything is made up (notified body "0000"). Run with `node scripts/factory/run-pg-tests.mjs
 * modules/compliance`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'renewals-w2a66'
const idOf = (key: string) => seedUuid(NS, key)
const T = idOf('tenant')
const brand = idOf('party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}

const PEOPLE = { owner: newId(), quality: newId(), reader: newId(), stranger: newId() } as const
type Person = keyof typeof PEOPLE
const ROLES: Record<Exclude<Person, 'stranger'>, string> = { owner: 'owner', quality: 'quality_inspector', reader: 'read_only' }
function grantOf(person: Person): Grant {
  const template = templateOf(person === 'stranger' ? 'quality_inspector' : ROLES[person])!
  // The stranger holds the same permissions, but only for another brand: the certificate is not theirs to see.
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: person === 'stranger' ? [newId()] : 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: [grantOf(person)] })

async function call(person: Person, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(person: Person, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(person: Person, method: 'GET' | 'POST' | 'PATCH', url: string, payload: unknown, status: number): Promise<string[]> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return ((answer.body.error?.issues ?? []) as Json[]).map((issue) => issue.path)
}

const errors: string[] = []
const log: Log = { info: () => undefined, warn: () => undefined, error: (fields, message) => errors.push(`${message} ${JSON.stringify(fields)}`) }
const evaluate = () => runAlertEvaluation({ database: h.database, log, clock: h.clock })
const fire = () => fireDueTimers({ database: h.database, log, clock: h.clock })
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: PEOPLE.owner, grants: [grantOf('owner')], requestId: newId() })
const PDF = Buffer.from('%PDF-1.4\n% made-up test answer\n%%EOF\n')

const ids = {} as { style: string; rev1: string; cert: string; label: string; thread: string; colourway: string }
let today = ''
const styleUrl = () => `/product/styles/${ids.style}`
const reviewsOf = (revisionId: string) => admin(`SELECT * FROM "TypeChangeReview" WHERE "revisionId" = $1 ORDER BY "createdAt"`, [revisionId])

async function release(revisionId: string): Promise<Json> {
  const bom = (await ok('owner', 'GET', `${styleUrl()}/revisions/${revisionId}/bom`)).bom
  return (await ok('owner', 'POST', `${styleUrl()}/revisions/${revisionId}/release`, { version: bom.revision.version })).bom
}
async function copyOf(revisionId: string): Promise<Json> {
  return (await ok('owner', 'POST', `${styleUrl()}/revisions/${revisionId}/copy`, {}, 201)).bom
}
async function labelProblems(revisionId: string): Promise<{ printable: boolean; certificate: string | null }> {
  const label = await office().withClient((db) =>
    garmentLabelFor(db, {
      labelTemplateId: ids.label,
      styleId: ids.style,
      styleRevisionId: revisionId,
      colourwayId: ids.colourway,
      size: '52',
      identification: { kind: 'BATCH', value: 'B-TEST-1', recordType: null, recordId: null, reference: null },
      manufactured: null,
      date: today,
      marketLanguages: [],
    }),
  )
  return { printable: label.printable, certificate: label.problems.find((problem) => problem.path === 'certificate')?.message ?? null }
}

beforeAll(async () => {
  h = await startHarness('renewals_w2a66')
  h.clock.set(new Date())
  useCertificatesClock(h.clock)
  today = businessDate(h.clock.now())
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, role] of Object.entries(ROLES)) {
    const userId = PEOPLE[person as Person]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `w2a66-${person}@example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, userId, roleIds.get(role)])
  }
  // The tenant's file store: a FAKE R2 account (the harness keeps the files in a temporary folder).
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), T])
  ids.style = (await one(`SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = 'SEED-JKT-01'`, [T])).id
  ids.rev1 = (await one(`SELECT id FROM "StyleRevision" WHERE "styleId" = $1 AND revision = 1`, [ids.style])).id
  ids.cert = (await one(`SELECT id FROM "Certificate" WHERE "tenantId" = $1 AND number = 'SEED-CERT-0001'`, [T])).id
  ids.label = (await one(`SELECT "labelTemplateId" AS id FROM "StyleRevision" WHERE id = $1`, [ids.rev1])).id
  ids.colourway = (await one(`SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = 'BLK'`, [ids.style])).id
  // A sewing thread of our own (made up): a copy of the seed lining as a THREAD.
  ids.thread = newId()
  await admin(
    `INSERT INTO "Item" SELECT (jsonb_populate_record(NULL::"Item", to_jsonb(i) || jsonb_build_object('id', $1::text, 'code', 'TEST-THR-400', 'name', 'Test bonded thread', 'kind', 'THREAD'))).* FROM "Item" i WHERE i."tenantId" = $2 AND i.code = 'SEED-LIN-200'`,
    [ids.thread, T],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
}, 180_000)

afterAll(async () => {
  useCertificatesClock(undefined)
  await app?.close()
  await h?.close()
})

describe('changes to an approved type (PRD-285, Annex V 7.2)', () => {
  const state = {} as { rev2: string; rev3: string; review2: Json; review3: Json }

  it("opens no review at a style's first release; a later revision's change to the approved type opens one and holds the class label", async () => {
    await release(ids.rev1)
    expect(await reviewsOf(ids.rev1)).toEqual([])
    const rev2 = await copyOf(ids.rev1)
    state.rev2 = rev2.revision.id
    await ok('owner', 'POST', `${styleUrl()}/revisions/${state.rev2}/bom/lines`, { version: rev2.revision.version, itemId: ids.thread, placement: 'Main seams', uom: 'M', qty: '12' }, 201)
    await release(state.rev2)
    const [review] = await reviewsOf(state.rev2)
    expect(review).toMatchObject({ status: 'OPEN', certificateId: ids.cert, comparedRevisionId: ids.rev1, styleId: ids.style })
    expect(review!.changes).toEqual([expect.objectContaining({ kind: 'SEAMS', what: 'Seams (thread)', before: '—', after: 'TEST-THR-400 Test bonded thread' })])
    expect((await admin(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1`, [review!.id])).map((row) => [row.type, row.payload.kinds])).toEqual([['compliance.type_change_found', ['SEAMS']]])
    // The register's views: waiting on the certificate, the style's tab, the label held in words.
    const listed = await ok('quality', 'GET', `/compliance/type-changes?certificateId=${ids.cert}&state=WAITING`)
    expect(listed.reviews.map((entry: Json) => [entry.revision.revision, entry.status, entry.holdsLabel])).toEqual([[2, 'OPEN', true]])
    state.review2 = listed.reviews[0]
    const tab = (await ok('quality', 'GET', `/compliance/type-changes/styles/${ids.style}`)).changes
    expect(tab.revision).toMatchObject({ id: state.rev2, status: 'RELEASED' })
    expect(tab.certificates).toEqual([expect.objectContaining({ labelHeld: true, comparedRevision: expect.objectContaining({ id: ids.rev1 }), changes: [expect.objectContaining({ kind: 'SEAMS' })] })])
    const label = await labelProblems(state.rev2)
    expect(label.printable).toBe(false)
    expect(label.certificate).toContain('Revision 2 changes the type certificate SEED-CERT-0001 approved (seams (thread))')
    // Revision 1 (the examined type) still prints its class label.
    expect((await labelProblems(ids.rev1)).certificate).toBeNull()
  })

  it('compares the next release with the approved type while a review still holds the label; a draft is compared live', async () => {
    const rev3 = await copyOf(state.rev2)
    state.rev3 = rev3.revision.id
    await release(state.rev3)
    const [review] = await reviewsOf(state.rev3)
    expect(review).toMatchObject({ status: 'OPEN', comparedRevisionId: ids.rev1 })
    const draft = await copyOf(state.rev3)
    const tab = (await ok('quality', 'GET', `/compliance/type-changes/styles/${ids.style}?revisionId=${draft.revision.id}`)).changes
    expect(tab.revision).toMatchObject({ id: draft.revision.id, status: 'DRAFT' })
    expect(tab.certificates[0]).toMatchObject({ labelHeld: false, reviews: [], comparedRevision: { id: ids.rev1 }, changes: [expect.objectContaining({ kind: 'SEAMS' })] })
    state.review3 = (await ok('quality', 'GET', `/compliance/type-changes/${review!.id}`)).review
  })

  it('records the telling, the answer with its file and a not-needed with its reason; the class label prints again', async () => {
    const url = `/compliance/type-changes/${state.review2.id}`
    expect(await refused('quality', 'POST', `${url}/answer`, { version: state.review2.version, decision: 'APPROVED', answeredOn: today }, 409)).toEqual(['refusal/NOT_NOTIFIED'])
    expect(await refused('reader', 'POST', `${url}/notify`, { version: state.review2.version }, 403)).toEqual([])
    await refused('quality', 'POST', `${url}/not-needed`, { version: state.review2.version, reason: '' }, 400)
    const told = (await ok('quality', 'POST', `${url}/notify`, { version: state.review2.version, note: 'Sent by mail to the notified body.' })).review
    expect(told).toMatchObject({ status: 'NOTIFIED', holdsLabel: true, decidedAt: null })
    expect(told.notifiedAt).not.toBeNull()
    await refused('quality', 'POST', `${url}/notify`, { version: state.review2.version }, 409)
    expect(await refused('quality', 'POST', `${url}/answer`, { version: told.version, decision: 'APPROVED', answeredOn: today }, 409)).toEqual(['refusal/ANSWER_FILE'])
    // The answer's file only through the review's own routes.
    expect((await call('quality', 'POST', '/files', { recordType: 'TypeChangeReview', recordId: state.review2.id, kind: 'DOCUMENT', originalName: 'answer.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: '0'.repeat(64) })).status).toBe(409)
    await refused('quality', 'POST', `${url}/answer-file`, { originalName: 'answer.png', contentType: 'image/png', sizeBytes: 10, sha256: 'a'.repeat(64) }, 400)
    const announced = await ok('quality', 'POST', `${url}/answer-file`, { originalName: 'answer.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: 'b'.repeat(64) }, 201)
    expect(announced.file.status).toBe('PENDING_UPLOAD')
    await storeGeneratedFile(h.files, office(), { companyId: null, recordType: 'TypeChangeReview', recordId: state.review2.id, kind: 'DOCUMENT', originalName: 'answer.pdf', contentType: 'application/pdf', body: PDF })
    expect(await refused('quality', 'POST', `${url}/answer`, { version: told.version, decision: 'APPROVED', answeredOn: plusCalendarDays(today, 1) }, 409)).toEqual(['refusal/ANSWER_DAY'])
    const approved = (await ok('quality', 'POST', `${url}/answer`, { version: told.version, decision: 'APPROVED', answeredOn: today, reference: 'ADD-0000-1', note: 'Addition to the certificate.' })).review
    expect(approved).toMatchObject({ status: 'APPROVED', holdsLabel: false, answeredOn: today, answerReference: 'ADD-0000-1', decidedBy: 'Person quality', decisionNote: 'Addition to the certificate.' })
    expect(approved.files).toHaveLength(1)
    const validTo = (await one(`SELECT "validTo"::text AS d FROM "Certificate" WHERE id = $1`, [ids.cert])).d
    const kept = await one(`SELECT "retainUntil" FROM "StoredFile" WHERE id = $1`, [approved.files[0].id])
    expect(new Date(kept.retainUntil).toISOString()).toBe(pdfRetainUntil(validTo).toISOString())
    expect((await labelProblems(state.rev2)).certificate).toBeNull()
    // Revision 3 still carries the change against the approved type: not needed, with the reason.
    const decided = (await ok('quality', 'POST', `/compliance/type-changes/${state.review3.id}/not-needed`, { version: state.review3.version, reason: 'Same thread as the approved addition of revision 2.' })).review
    expect(decided).toMatchObject({ status: 'NOT_NEEDED', holdsLabel: false, decisionNote: 'Same thread as the approved addition of revision 2.' })
    expect((await labelProblems(state.rev3)).certificate).toBeNull()
    expect((await admin(`SELECT payload->>'status' AS status FROM "OutboxEvent" WHERE type = 'compliance.type_change_decided' AND "tenantId" = $1 ORDER BY "occurredAt"`, [T])).map((row) => row.status)).toEqual(['NOTIFIED', 'APPROVED', 'NOT_NEEDED'])
  })
})

describe('certificate renewals (QHS-105, PRD-283)', () => {
  const url = () => `/compliance/certificates/${ids.cert}/renewals`
  const state = {} as { renewals: Json; successor: Json }

  it('alerts 180, 90 and 30 days before the last valid day through the rules and their timers', async () => {
    // The certificate's last valid day 100 days from today (test data only).
    await force(`UPDATE "Certificate" SET "validTo" = $2::date WHERE id = $1`, [ids.cert, plusCalendarDays(today, 100)])
    await evaluate()
    expect(await runRenewalStages({ database: h.database, log, clock: h.clock })).toMatchObject({ made: 2, failed: 0 })
    expect(await runRenewalStages({ database: h.database, log, clock: h.clock })).toMatchObject({ made: 0, failed: 0 })
    const rules = await admin(`SELECT threshold->>'daysBefore' AS days, "builtIn", enabled, severity FROM "AlertRule" WHERE "tenantId" = $1 AND "ruleKind" = 'CERTIFICATE_EXPIRING' ORDER BY (threshold->>'daysBefore')::int DESC`, [T])
    expect(rules).toEqual([
      { days: '180', builtIn: false, enabled: true, severity: 'WARNING' },
      { days: '90', builtIn: false, enabled: true, severity: 'WARNING' },
      { days: '30', builtIn: true, enabled: true, severity: 'CRITICAL' },
    ])
    await evaluate()
    // The 30-day timer comes once the date is within its lead and the engine's horizon (60 days more).
    expect((await admin(`SELECT "timerKey", status FROM "DueTimer" WHERE "recordId" = $1 ORDER BY "fireAt"`, [ids.cert])).map((row) => `${row.timerKey} ${row.status}`)).toEqual(['CERTIFICATE_EXPIRY:-180d PENDING', 'CERTIFICATE_EXPIRY:-90d PENDING'])
    await fire()
    expect(errors).toEqual([])
    const alert = await one(`SELECT state, facts FROM "Alert" WHERE "recordId" = $1`, [ids.cert])
    expect(alert).toMatchObject({ state: 'OPEN', facts: { daysBefore: 180, timerKey: 'CERTIFICATE_EXPIRY:-180d', daysLeft: 100 } })
    state.renewals = (await ok('quality', 'GET', url())).renewals
    expect(state.renewals.stages.map((stage: Json) => [stage.daysBefore, stage.timer?.status, stage.alert?.state ?? null, stage.recipientRole?.name ?? null])).toEqual([
      [180, 'FIRED', 'OPEN', expect.any(String)],
      [90, 'PENDING', null, expect.any(String)],
      [30, undefined, null, expect.any(String)],
    ])
    expect(state.renewals.stages.map((stage: Json) => stage.fireOn)).toEqual([plusCalendarDays(today, -80), plusCalendarDays(today, 10), plusCalendarDays(today, 70)])
    expect(state.renewals).toMatchObject({ nextStep: 'START', renewal: null, successor: null, window: { phase: 'CLOSED' } })
    // A reader sees the stages and (alerts.view) the alerts, but no successor to pick and may not start anything.
    const read = (await ok('reader', 'GET', url())).renewals
    expect(read.stages[0].alert).toMatchObject({ state: 'OPEN', occurrence: 1 })
    expect(read.candidates).toEqual([])
    expect(await refused('reader', 'POST', `${url()}/start`, { version: state.renewals.certificate.version }, 403)).toEqual([])
    await refused('stranger', 'GET', url(), undefined, 404)
  })

  it('starts the renewal once, as a task with the steps, and records the application to the notified body', async () => {
    const version = state.renewals.certificate.version
    const started = (await ok('quality', 'POST', `${url()}/start`, { version, language: 'en' })).renewals
    expect(started.nextStep).toBe('APPLY')
    expect(started.renewal.task).toMatchObject({ title: 'Renew certificate SEED-CERT-0001', status: 'OPEN', dueDate: started.window.closes, assignee: 'Person quality' })
    expect(started.renewal.task.checklist).toHaveLength(5)
    expect(await one(`SELECT "recordType", "recordId" FROM "Task" WHERE id = $1`, [started.renewal.taskId])).toEqual({ recordType: 'Certificate', recordId: ids.cert })
    await refused('quality', 'POST', `${url()}/start`, { version, language: 'en' }, 409)
    expect(await refused('quality', 'POST', `${url()}/start`, { version: started.certificate.version }, 409)).toEqual(['refusal/ALREADY_STARTED'])
    expect(await refused('quality', 'POST', `${url()}/applied`, { version: started.certificate.version, appliedOn: plusCalendarDays(today, 2) }, 409)).toEqual(['refusal/APPLIED_IN_FUTURE'])
    const applied = (await ok('quality', 'POST', `${url()}/applied`, { version: started.certificate.version, appliedOn: today, reference: 'NB-REQ-1' })).renewals
    expect(applied).toMatchObject({ nextStep: 'LINK', renewal: { appliedOn: today, reference: 'NB-REQ-1', inWindow: false } })
    expect(applied.log.map((entry: Json) => entry.action)).toEqual(['STARTED', 'APPLIED'])
    // B-W2b-17: the renewal is a CertificateRenewal row — STARTED with its task, window and language, then APPLIED once.
    expect(await admin(`SELECT status::text AS status, "taskId"::text AS "taskId", language, "appliedOn"::text AS "appliedOn", "applicationReference" AS reference, "appliedInWindow" AS "inWindow" FROM "CertificateRenewal" WHERE "certificateId" = $1`, [ids.cert])).toEqual([
      { status: 'APPLIED', taskId: started.renewal.taskId, language: 'en', appliedOn: today, reference: 'NB-REQ-1', inWindow: false },
    ])
    expect(applied.renewal).toMatchObject({ status: 'APPLIED', window: { opens: started.window.opens, closes: started.window.closes } })
    expect(await refused('quality', 'POST', `${url()}/applied`, { version: applied.certificate.version, appliedOn: today }, 409)).toEqual(['refusal/ALREADY_APPLIED'])
    state.renewals = applied
  })

  it('links the registered renewal: the old certificate stops its timers and alerts and leaves the window', async () => {
    const created = (await ok('owner', 'POST', '/compliance/certificates', { companyId: null, holderPartyId: brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: 'TEST-CERT-RENEW', notifiedBodyName: 'Test Notified Body', notifiedBodyNumber: '0000', modelReference: 'SEED-JKT-01', validFrom: plusCalendarDays(today, 90), validTo: plusCalendarDays(today, 1800) }, 201)).certificate
    expect(await refused('quality', 'POST', `${url()}/successor`, { version: state.renewals.certificate.version, successorId: created.id }, 409)).toEqual(['refusal/SUCCESSOR_NOT_REGISTERED'])
    await storeGeneratedFile(h.files, office(), { companyId: null, recordType: 'Certificate', recordId: created.id, kind: 'CERTIFICATE', originalName: 'renewal.pdf', contentType: 'application/pdf', body: PDF })
    const issued = (await ok('owner', 'POST', `/compliance/certificates/${created.id}/issue`, { version: created.version })).certificate
    expect((await ok('quality', 'GET', url())).renewals.candidates.map((entry: Json) => entry.number)).toEqual(['TEST-CERT-RENEW'])
    const linked = (await ok('quality', 'POST', `${url()}/successor`, { version: state.renewals.certificate.version, successorId: issued.id })).renewals
    expect(linked).toMatchObject({ nextStep: 'RENEWED', successor: { id: issued.id, number: 'TEST-CERT-RENEW' }, candidates: [], carriedOver: [{ code: 'SEED-JKT-01', covered: false }] })
    // B-W2b-17: the renewal row is RENEWED with the new certificate; the log reads the rows.
    expect(await admin(`SELECT status::text AS status, "newCertificateId"::text AS "newCertificateId" FROM "CertificateRenewal" WHERE "certificateId" = $1`, [ids.cert])).toEqual([{ status: 'RENEWED', newCertificateId: issued.id }])
    expect(linked.log.map((entry: Json) => [entry.action, entry.detail])).toEqual([['STARTED', expect.any(String)], ['APPLIED', today], ['RENEWED', 'TEST-CERT-RENEW']])
    expect((await admin(`SELECT "timerKey", status FROM "DueTimer" WHERE "recordId" = $1 ORDER BY "fireAt"`, [ids.cert])).map((row) => `${row.timerKey} ${row.status}`)).toEqual(['CERTIFICATE_EXPIRY:-180d FIRED', 'CERTIFICATE_EXPIRY:-90d CANCELLED'])
    expect(await one(`SELECT state, resolution FROM "Alert" WHERE "recordId" = $1`, [ids.cert])).toEqual({ state: 'RESOLVED', resolution: 'CLEARED' })
    expect((await admin(`SELECT type FROM "OutboxEvent" WHERE subject = $1 AND type LIKE 'compliance.%' ORDER BY "occurredAt"`, [ids.cert])).map((row) => row.type)).toEqual(['compliance.renewal_started', 'compliance.renewal_applied', 'compliance.certificate_renewed'])
    // The engine sets no new timer for a renewed certificate; the successor says what it renews; the link is set once.
    await evaluate()
    expect((await admin(`SELECT count(*)::int AS n FROM "DueTimer" WHERE "recordId" = $1 AND status = 'PENDING'`, [ids.cert]))[0]!.n).toBe(0)
    expect((await ok('quality', 'GET', `/compliance/certificates/${issued.id}/renewals`)).renewals.renews).toMatchObject({ id: ids.cert })
    expect(await refused('quality', 'POST', `${url()}/successor`, { version: linked.certificate.version, successorId: issued.id }, 409)).toEqual(['refusal/ALREADY_RENEWED'])
    expect(await refused('quality', 'POST', `${url()}/start`, { version: linked.certificate.version }, 409)).toEqual(['refusal/ALREADY_RENEWED'])
    expect(errors).toEqual([])
  })
})
