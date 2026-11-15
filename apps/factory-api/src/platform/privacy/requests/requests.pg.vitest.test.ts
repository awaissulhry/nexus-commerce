import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DataRequestKind, DataRequestStatus, DataSubjectKind, ErasureMethod } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { KEPT_WHY_WORDS } from '@nexus/factory-domain/privacy/retention/erasure'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS, REQUEST_HELD_WORDS } from '@nexus/factory-domain/privacy/retention/requests'
import { ERASURE_METHODS } from '@nexus/factory-domain/privacy/retention/retention'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFloorAuth } from '../../../../../../packages/factory-db/seed/floor-auth'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useReadLog } from '../../audit/reads/switch'
import { addRole, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { applySystemRoleChanges, systemRoleChanges } from '../../auth/roles/system-roles'
import { putGeneratedFile, recordGeneratedFile } from '../../files/files'
import { systemContext } from '../../outbox/system'
import { collectPackage } from './package'

/**
 * Data protection in depth (B-W2b-405; PLT-202, PLT-203; PV1:01, PV1:02, PV1:03, PV1:04; GDPR arts. 12, 15, 17, 20) on the local
 * stack: a throwaway PostgreSQL 17 from the migrations (the runtime login: row-level security, grants and the
 * …_privacy_integration_w2b_guards triggers are real), the seeds of one tenant (company A's prospect inquiry SEED-INQ-0001, the
 * parties' contacts, floor workers still active), a real administrator with two-factor (the erasure asks a fresh code every time),
 * and test sessions for the walls. Every person and text is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/privacy/requests`.
 */

let h: Harness
let app: FastifyInstance
const NS = 'privacy-405-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const companyB = seedUuid(NS, 'company:B')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const system = () => callerFor(h.database, systemContext(T, newId()))

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  viewer: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['privacy.requests.view'])] } as SessionContext,
  companyB: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(['privacy.requests.view', 'privacy.requests.manage'], [companyB])] } as SessionContext,
}
const as = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })

let desk: { browser: Browser; secret: string; userId: string }
let keys = 0
const send = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) => desk.browser.send(method, url, body, { headers: { 'x-factory-company': companyA, 'idempotency-key': `w2b405-${++keys}-${newId()}` } })
async function ok(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await send(method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('privacy_405')
  await seedCore({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  await seedFloorAuth({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
  const user = await addUser(h, tenant, { email: 'privacy.desk.405@example.com' })
  await addRole(h, tenant, user.id, 'admin')
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  desk = { browser, secret: await enrolTotp(h, browser), userId: user.id }
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  useReadLog(true)
}, 300_000)

afterAll(async () => {
  useReadLog(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('the lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...DATA_SUBJECT_KINDS].sort()).toEqual(Object.values(DataSubjectKind).sort())
    expect([...DATA_REQUEST_KINDS].sort()).toEqual(Object.values(DataRequestKind).sort())
    expect([...DATA_REQUEST_STATUSES].sort()).toEqual(Object.values(DataRequestStatus).sort())
    expect([...ERASURE_METHODS].sort()).toEqual(Object.values(ErasureMethod).sort())
  })
})

describe("a prospect's access request: the 30-day clock, identity first, the package with the files (PLT-202, PV1:03)", () => {
  let inquiryId = ''
  let request: Json

  beforeAll(async () => {
    inquiryId = (await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0001'`, [T])).id
    // A made-up tech pack the prospect sent: a file of the inquiry, in the store.
    const caller = system()
    const prepared = await putGeneratedFile(h.files, caller, { companyId: companyA, recordType: 'Inquiry', recordId: inquiryId, kind: 'DOCUMENT', originalName: 'tech-pack.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF-1.4\n% made-up tech pack\n%%EOF\n'), visibility: ['OFFICE'] })
    await command(caller, { name: 'test.techPack', input: { inquiryId } }, async (tools) => {
      await recordGeneratedFile(tools, prepared)
      tools.audit({ recordType: 'Inquiry', recordId: inquiryId, companyId: companyA, after: { file: 'tech pack' } })
      return null
    })
  })

  it('is received with its clock; nothing is collected before the identity is checked', async () => {
    request = (await ok('POST', '/privacy/requests', { companyId: companyA, personKind: 'PROSPECT', personRecordId: inquiryId, kind: 'ACCESS', note: 'Asked by mail (made up).' }, 201)).request
    expect(request).toMatchObject({ status: 'RECEIVED', kind: 'ACCESS', person: { kind: 'PROSPECT', recordType: 'Inquiry', erased: false }, extended: false, overdue: false, package: null, collect: { state: 'NONE' } })
    expect(new Date(request.dueAt).getTime() - new Date(request.receivedAt).getTime()).toBe(720 * 3_600_000)
    expect(request.actions.collect.held.code).toBe('NOT_STARTED')
    const early = await send('POST', `/privacy/requests/${request.id}/collect`)
    expect(early.status).toBe(409)
    expect(early.body.error.message).toBe(REQUEST_HELD_WORDS.NOT_STARTED)
    request = (await ok('POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'Replied from the address on the inquiry.' })).request
    expect(request).toMatchObject({ status: 'IN_PROGRESS', identityCheckedBy: { id: desk.userId } })
    expect(request.actions.extend.allowed).toBe(true)
    request = (await ok('POST', `/privacy/requests/${request.id}/extend`, { version: request.version, months: 1, reason: 'Many records to collect (made up).' })).request
    expect(request.extended).toBe(true)
    expect(new Date(request.dueAt).getTime() - new Date(request.receivedAt).getTime()).toBe(1440 * 3_600_000)
    expect((await send('POST', `/privacy/requests/${request.id}/extend`, { version: request.version, months: 1, reason: 'Again.' })).status).toBe(409)
  })

  it('collects the package in the background: the records as JSON, the files, checksums; downloaded (read log); done', async () => {
    request = (await ok('POST', `/privacy/requests/${request.id}/collect`, undefined, 202)).request
    expect(request.collect.state).toBe('RUNNING')
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'privacy.request_collect_asked'`, [T])).map((row) => row.payload.requestId)).toContain(request.id)
    expect(await collectPackage(system(), request.id, { files: h.files })).toBe('built')
    request = (await ok('GET', `/privacy/requests/${request.id}`)).request
    expect(request.collect.state).toBe('READY')
    expect(request.package).toMatchObject({ name: expect.stringMatching(/^personal-data-\d{4}-\d{2}-\d{2}\.zip$/) })
    const file = await one(`SELECT "recordType", "recordId", visibility::text[] AS visibility, "storeAccountId", "storageKey", "sizeBytes" FROM "StoredFile" WHERE id = $1`, [request.package.fileId])
    expect(file).toMatchObject({ recordType: 'DataRequest', recordId: request.id, visibility: ['OFFICE'] })
    const zip = Buffer.from((await h.files.storage.read(system(), file.storeAccountId, file.storageKey, file.sizeBytes))!).toString('latin1')
    for (const name of ['README.txt', 'data.json', 'sections/person.json', 'sections/inquiryLines.json', 'files/001-tech-pack.pdf', 'SHA256SUMS.txt']) expect(zip).toContain(name)
    // files.read never reaches it: only the privacy routes.
    expect((await send('GET', `/files/${request.package.fileId}`)).status).toBe(404)
    const download = await ok('GET', `/privacy/requests/${request.id}/package`)
    expect(download.download.url).toEqual(expect.any(String))
    expect(await admin(`SELECT action FROM "ReadLog" WHERE "tenantId" = $1 AND "recordType" = 'DataRequest' AND "recordId" = $2`, [T, request.id])).toEqual([{ action: 'DOWNLOAD' }])
    request = (await ok('POST', `/privacy/requests/${request.id}/done`, { version: request.version })).request
    expect(request).toMatchObject({ status: 'DONE', decidedBy: { id: desk.userId } })
    expect(request.actions.refuse.held.code).toBe('CLOSED')
  })

  it('refuses what is not allowed: a reader records nothing, another company sees nothing, a request from the future, a closed request', async () => {
    expect((await as('viewer', 'POST', '/privacy/requests', { companyId: companyA, personKind: 'PROSPECT', personRecordId: inquiryId, kind: 'ACCESS' })).statusCode).toBe(403)
    expect((await as('viewer', 'GET', `/privacy/requests/${request.id}`)).statusCode).toBe(200)
    expect((await as('companyB', 'GET', `/privacy/requests/${request.id}`)).statusCode).toBe(404)
    const listed = (await as('companyB', 'GET', '/privacy/requests?view=all')).json()
    expect(listed.requests.map((row: Json) => row.id)).not.toContain(request.id)
    const future = await send('POST', '/privacy/requests', { companyId: companyA, personKind: 'PROSPECT', personRecordId: inquiryId, kind: 'ACCESS', receivedAt: new Date(Date.now() + 86_400_000).toISOString() })
    expect(future.status).toBe(400)
    expect(future.body.error.issues[0].path).toBe('receivedAt')
    expect((await send('POST', `/privacy/requests/${request.id}/refuse`, { version: request.version, reason: 'Too late.' })).status).toBe(409)
    const correction = (await ok('POST', '/privacy/requests', { companyId: companyA, personKind: 'PROSPECT', personRecordId: inquiryId, kind: 'CORRECTION' }, 201)).request
    const refused = (await ok('POST', `/privacy/requests/${correction.id}/refuse`, { version: correction.version, reason: 'The data is correct as recorded (made up).' })).request
    expect(refused).toMatchObject({ status: 'REFUSED', refusalReason: 'The data is correct as recorded (made up).' })
  })
})

describe('an erasure: previewed with the law’s exceptions, a fresh code and the typed name, logged (PLT-203, PV1:01, PV1:02)', () => {
  it("erases a rider's contact: the contact anonymised, their personal custom value deleted, the customer record and immutable rows kept", async () => {
    const contact = await one<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "PartyContact" WHERE "tenantId" = $1 AND email = 'rider.p4@example.com'`, [T])
    // A made-up personal custom field on the rider's party, with a value (B-W2b-421's PERSONAL audience).
    const fieldId = newId()
    await admin(`INSERT INTO "CustomField" (id, "tenantId", "recordType", code, key, type, "labelIt", "labelEn", audience, "createdById") VALUES ($1, $2, 'Party', 'nickname_405', 'field:Party:nickname_405', 'TEXT', 'Soprannome', 'Nickname', 'PERSONAL', $3)`, [fieldId, T, desk.userId])
    await admin(`INSERT INTO "CustomFieldValue" (id, "tenantId", "fieldId", "recordType", "recordId", key, value, "changedAt", "changedById") VALUES ($1, $2, $3, 'Party', $4, $5, '"Made-up nickname"'::jsonb, now(), $6)`, [newId(), T, fieldId, contact.partyId, `value:${fieldId}:${contact.partyId}`, desk.userId])
    let request = (await ok('POST', '/privacy/requests', { companyId: companyA, personKind: 'CONTACT', personRecordId: contact.id, kind: 'ERASURE' }, 201)).request
    expect(request.actions.erase.held.code).toBe('NOT_STARTED')
    request = (await ok('POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'Called back on the number we hold.' })).request
    const preview = await ok('GET', `/privacy/requests/${request.id}/erasure`)
    expect(preview.person).toMatchObject({ kind: 'CONTACT', name: 'Seed Private Rider', erased: false })
    expect(preview.blocked).toBeNull()
    expect(preview.anonymised).toEqual([expect.objectContaining({ recordType: 'PartyContact', count: 1, erasedFields: ['name', 'email', 'phone'] })])
    expect(preview.deleted).toEqual([expect.objectContaining({ recordType: 'CustomFieldValue', count: 1 })])
    expect(preview.kept).toContainEqual(expect.objectContaining({ recordType: 'Party', why: { code: 'CUSTOMER', words: KEPT_WHY_WORDS.CUSTOMER } }))
    expect(preview.action.allowed).toBe(true)

    // A fresh code first (a fixed LEGAL action), then the typed name, then the erasure.
    const noCode = await send('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by letter (made up).', confirmName: 'Seed Private Rider' })
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues[0].path).toBe('stepUp')
    await stepUp(h, desk.browser, desk.secret)
    const wrongName = await send('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by letter (made up).', confirmName: 'Seed Rider' })
    expect(wrongName.status).toBe(400)
    expect(wrongName.body.error.issues[0].path).toBe('confirmName')
    const erased = await ok('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by letter (made up).', confirmName: '  seed private RIDER ' })
    expect(erased.erased).toMatchObject({ anonymised: 1, deleted: 1 })
    expect(erased.request).toMatchObject({ status: 'IN_PROGRESS', person: { erased: true }, erasure: { anonymised: 1, deleted: 1 } })
    expect(await one(`SELECT name, email, phone, status, "erasedAt" IS NOT NULL AS erased FROM "PartyContact" WHERE id = $1`, [contact.id])).toEqual({ name: '', email: null, phone: null, status: 'ARCHIVED', erased: true })
    expect((await admin(`SELECT id FROM "CustomFieldValue" WHERE "fieldId" = $1`, [fieldId])).length).toBe(0)
    const records = await admin(`SELECT "recordType", method, "erasedFields", "keptWhy" FROM "ErasureRecord" WHERE "dataRequestId" = $1 ORDER BY "recordType"`, [request.id])
    expect(records).toContainEqual({ recordType: 'PartyContact', method: 'ANONYMISED', erasedFields: ['name', 'email', 'phone'], keptWhy: null })
    expect(records).toContainEqual({ recordType: 'Party', method: 'KEPT', erasedFields: [], keptWhy: KEPT_WHY_WORDS.CUSTOMER })
    // The decision is logged with the reason, never the person's name.
    const logged = await one(`SELECT reason, after::text AS after FROM "AuditLog" WHERE "recordType" = 'DataRequest' AND "recordId" = $1 AND action = 'privacy.erase'`, [request.id])
    expect(logged.reason).toBe('Asked by letter (made up).')
    expect(logged.after).not.toContain('Seed Private Rider')
    expect((await send('POST', `/privacy/requests/${request.id}/erase`, { version: erased.request.version, reason: 'Again.', confirmName: 'Erased person' })).status).toBe(409)
    expect((await ok('POST', `/privacy/requests/${request.id}/done`, { version: erased.request.version })).request.status).toBe('DONE')
  })

  it("erases a prospect: the inquiry's prospect columns blank for good, the inquiry stays (PV1:02)", async () => {
    const inquiryId = (await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0001'`, [T])).id
    let request = (await ok('POST', '/privacy/requests', { companyId: companyA, personKind: 'PROSPECT', personRecordId: inquiryId, kind: 'ERASURE' }, 201)).request
    request = (await ok('POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'Replied from the address on the inquiry.' })).request
    const name = request.person.name
    await stepUp(h, desk.browser, desk.secret)
    const erased = await ok('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by mail (made up).', confirmName: name })
    expect(erased.erased.anonymised).toBe(1)
    expect(await one(`SELECT "prospectName", "prospectEmail", "prospectCompany", "prospectPhone", "prospectErasedAt" IS NOT NULL AS erased, status FROM "Inquiry" WHERE id = $1`, [inquiryId])).toMatchObject({ prospectName: null, prospectEmail: null, prospectCompany: null, prospectPhone: null, erased: true })
  })

  it('refuses while the person still works here (409 in words); nothing is written', async () => {
    const worker = await one<{ id: string; companyId: string }>(`SELECT id, "companyId" FROM "Worker" WHERE "tenantId" = $1 AND status = 'ACTIVE' ORDER BY id LIMIT 1`, [T])
    let request = (await ok('POST', '/privacy/requests', { companyId: worker.companyId, personKind: 'WORKER', personRecordType: 'Worker', personRecordId: worker.id, kind: 'ERASURE' }, 201)).request
    request = (await ok('POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'In person at the plant (made up).' })).request
    expect((await ok('GET', `/privacy/requests/${request.id}/erasure`)).blocked.code).toBe('STILL_ACTIVE')
    await stepUp(h, desk.browser, desk.secret)
    const refused = await send('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked in person.', confirmName: request.person.name })
    expect(refused.status).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('privacy/STILL_ACTIVE')
    expect((await admin(`SELECT id FROM "ErasureRecord" WHERE "dataRequestId" = $1`, [request.id])).length).toBe(0)
  })
})

describe('download my data (shell.profile) and the safety-report form (PV1:04)', () => {
  it('asks for my own package, collected in the background; the first download closes the request', async () => {
    const asked = await ok('POST', '/privacy/my-data', undefined, 202)
    expect(asked.mayAsk).toBe(false)
    expect((await send('POST', '/privacy/my-data')).status).toBe(409)
    expect(await collectPackage(system(), asked.requestId, { files: h.files })).toBe('built')
    const mine = await ok('GET', '/privacy/my-data')
    expect(mine.requests[0]).toMatchObject({ id: asked.requestId, status: 'IN_PROGRESS', collect: { state: 'READY' } })
    expect((await ok('GET', `/privacy/my-data/${asked.requestId}/package`)).download.url).toEqual(expect.any(String))
    expect(await one(`SELECT status, "personKind", "identityCheckedById", "decidedById" FROM "DataRequest" WHERE id = $1`, [asked.requestId])).toEqual({ status: 'DONE', personKind: 'USER', identityCheckedById: desk.userId, decidedById: desk.userId })
    expect((await as('viewer', 'GET', `/privacy/my-data/${asked.requestId}/package`)).statusCode).toBe(404)
  })

  it("keeps a company's outside doors shut until its safety-report notice is published", async () => {
    const form = await ok('GET', `/privacy/safety-report-form?companyId=${companyA}`)
    expect(form).toMatchObject({ on: false, notice: null, mayTurnOn: false, held: { code: 'NO_NOTICE' } })
    const refused = await send('PUT', '/privacy/safety-report-form', { companyId: companyA, on: true })
    expect(refused.status).toBe(409)
    expect((await desk.browser.send('GET', '/public/safety-reports/status')).body).toMatchObject({ open: false })
  })
})
