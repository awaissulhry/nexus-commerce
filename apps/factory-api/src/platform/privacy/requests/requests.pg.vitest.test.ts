import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DataRequestKind, DataRequestStatus, DataSubjectKind, ErasureMethod } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { ERASURE_BLOCKED_WORDS, KEPT_WHY_WORDS } from '@nexus/factory-domain/privacy/retention/erasure'
import { DATA_REQUEST_KINDS, DATA_REQUEST_STATUSES, DATA_SUBJECT_KINDS, REQUEST_HELD_WORDS } from '@nexus/factory-domain/privacy/retention/requests'
import { ERASURE_METHODS } from '@nexus/factory-domain/privacy/retention/retention'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
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
/** A made-up row written as the owner login: every column given, the database's guards on. */
async function insertRow(table: string, row: Record<string, unknown>): Promise<void> {
  const full = { tenantId: T, ...row }
  const columns = Object.keys(full).map((column) => `"${column}"`).join(', ')
  await admin(`INSERT INTO "${table}" (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::"${table}", $1::jsonb)`, [JSON.stringify(full)])
}
/** The same, with the guards off for this one row (a fixture of another module whose own rules are not under test). */
async function insertFixture(table: string, row: Record<string, unknown>): Promise<void> {
  await h.db.admin.query('BEGIN')
  try {
    await h.db.admin.query("SET LOCAL session_replication_role = 'replica'")
    await insertRow(table, row)
    await h.db.admin.query('COMMIT')
  } catch (error) {
    await h.db.admin.query('ROLLBACK')
    throw error
  }
}

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
  await seedEmail({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }
  const user = await addUser(h, tenant, { email: 'privacy.desk.405@example.com' })
  await addRole(h, tenant, user.id, 'admin')
  const browser = new Browser(h.app)
  const answer = await browser.signIn(tenant.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in: ${answer.status} ${JSON.stringify(answer.body)}`)
  desk = { browser, secret: await enrolTotp(h, browser), userId: user.id }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
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
  it("erases a rider's contact: the contact anonymised, their personal custom value deleted, the customer record kept", async () => {
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

  it("blanks the mail they sent and got, the messages they wrote and their values in their record's history; the rows stay (PV1:01, B-W2b-F54)", async () => {
    const partyId = seedUuid(NS, 'party:P1')
    const contactId = newId()
    const address = 'erika.prova.f54@example.com'
    await insertRow('PartyContact', { id: contactId, partyId, name: 'Erika Prova', email: address, phone: '+39 000 0000154', roles: ['ORDERS'] })
    // A thread of the party: a mail of hers became its INBOUND message (no author id: she was not known as a contact yet), she
    // posted from the portal as a portal person of the party with her address, and an office person wrote a note.
    const threadId = newId()
    await insertRow('Thread', { id: threadId, companyId: companyA, partyId, recordType: 'Party', recordId: partyId, replyToken: 'f54threadtokenabcdefghijklmnop', createdById: desk.userId })
    const fromMail = newId()
    const posted = newId()
    const note = newId()
    const at = new Date(Date.now() - 3_600_000).toISOString()
    await insertRow('Message', { id: fromMail, threadId, partyId, direction: 'INBOUND', audience: 'PARTNER', channel: 'EMAIL', authorKind: 'PARTY', authorName: 'Erika Prova', bodyText: 'Made-up mail: please call me on my mobile.', bodyHtml: '<p>Made-up mail</p>', emailMessageId: '<f54-in@mail.example.com>', at })
    await insertRow('Message', { id: posted, threadId, partyId, direction: 'INBOUND', audience: 'PARTNER', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'Erika Prova', bodyText: 'Made-up portal post.', at })
    await insertRow('Message', { id: note, threadId, direction: 'INTERNAL_NOTE', audience: 'OFFICE', channel: 'APP', authorKind: 'USER', authorId: desk.userId, authorName: 'Privacy desk', bodyText: 'Made-up note: Erika asked for a call.', at })
    const portalPerson = newId()
    await insertFixture('User', { id: portalPerson, email: address, displayName: 'Erika Prova', audience: 'PARTNER', partyId, status: 'DEACTIVATED' })
    await insertRow('AuditLog', { id: newId(), companyId: companyA, partyId, audience: 'PARTNER', actorId: portalPerson, action: 'threads.post', recordType: 'Message', recordId: posted, after: { channel: 'PORTAL' }, requestId: `f54-${posted}` })
    // Two mails from her (one matched to the thread, one waiting to be sorted) and three to her.
    const account = (await one<{ accountId: string }>(`SELECT "accountId" FROM "InboundEmail" WHERE "tenantId" = $1 LIMIT 1`, [T])).accountId
    const mail = (id: string, extra: Record<string, unknown>) => ({ id, companyId: companyA, accountId: account, receiptId: newId(), sesMessageId: `f54-${id}`, s3Bucket: 'factory-inbound-f54', s3Key: `inbound/${id}`, receivedAt: at, envelopeFrom: address, envelopeTo: ['orders@example.com'], fromAddress: address, fromName: 'Erika Prova', to: ['orders@example.com'], subject: 'Made-up order question', bodyText: 'Made-up text with her number.', spfVerdict: 'PASS', dkimVerdict: 'PASS', dmarcVerdict: 'PASS', spamVerdict: 'PASS', virusVerdict: 'PASS', fetchedAt: at, ...extra })
    const matched = newId()
    const waiting = newId()
    await insertRow('InboundEmail', mail(matched, { status: 'MATCHED', threadId, messageId: fromMail, matchedBy: 'HEADERS', emailMessageId: '<f54-in@mail.example.com>', bodyHtml: '<p>Made-up</p>' }))
    await insertRow('InboundEmail', mail(waiting, { status: 'TRIAGE', emailMessageId: '<f54-waiting@mail.example.com>' }))
    const identity = seedUuid(NS, 'email:identity:A:conversation')
    const outbound = (id: string, extra: Record<string, unknown>) => ({ id, companyId: companyA, identityId: identity, templateKey: 'sales.order_confirmed', locale: 'it', fromAddress: 'orders@mail.example.com', fromName: 'Seed A', to: [address.toUpperCase(), 'colleague.f54@example.com'], subject: 'Made-up order confirmation for Erika', emailMessageId: `<${id}@mail.example.com>`, queuedAt: at, ...extra })
    const delivered = newId()
    const queued = newId()
    const sending = newId()
    await insertRow('EmailOutbound', outbound(delivered, { status: 'DELIVERED', sentAt: at, deliveredAt: at, attempts: 1 }))
    await insertRow('EmailOutbound', outbound(queued, { to: [address], cc: ['boss.f54@example.com'] }))
    await insertRow('EmailOutbound', outbound(sending, { to: [address], status: 'SENDING', attempts: 1, claimedUntil: new Date(Date.now() + 120_000).toISOString() }))
    // Her record's history: one row holding her details, one that holds none.
    const named = newId()
    const plain = newId()
    await insertRow('AuditLog', { id: named, companyId: companyA, audience: 'OFFICE', actorId: desk.userId, action: 'parties.updateContact', recordType: 'PartyContact', recordId: contactId, before: { name: 'Erika P.', email: 'old.f54@example.com', roles: ['ORDERS'] }, after: { name: 'Erika Prova', email: address, roles: ['ORDERS'] }, requestId: `f54-${named}` })
    await insertRow('AuditLog', { id: plain, companyId: companyA, audience: 'OFFICE', actorId: desk.userId, action: 'parties.contactRoles', recordType: 'PartyContact', recordId: contactId, before: { roles: [] }, after: { roles: ['ORDERS'] }, requestId: `f54-${plain}` })

    let request = (await ok('POST', '/privacy/requests', { companyId: companyA, personKind: 'CONTACT', personRecordId: contactId, kind: 'ERASURE' }, 201)).request
    request = (await ok('POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'Replied from the address we hold (made up).' })).request
    // A mail to her is being sent this very minute: the erasure waits for it (409 in words).
    expect((await ok('GET', `/privacy/requests/${request.id}/erasure`)).blocked).toEqual({ code: 'MAIL_SENDING', words: ERASURE_BLOCKED_WORDS.MAIL_SENDING })
    await stepUp(h, desk.browser, desk.secret)
    const waitFor = await send('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by mail (made up).', confirmName: 'Erika Prova' })
    expect(waitFor.status).toBe(409)
    expect(waitFor.body.error.issues[0].path).toBe('privacy/MAIL_SENDING')
    await admin(`UPDATE "EmailOutbound" SET status = 'SENT', "sentAt" = now(), "claimedUntil" = NULL WHERE id = $1`, [sending])

    const preview = await ok('GET', `/privacy/requests/${request.id}/erasure`)
    expect(preview.blocked).toBeNull()
    const group = (type: string) => preview.anonymised.find((entry: Json) => entry.recordType === type)
    expect(group('PartyContact')).toMatchObject({ count: 1, erasedFields: ['name', 'email', 'phone'] })
    expect(group('Message')).toMatchObject({ count: 2, erasedFields: expect.arrayContaining(['authorName', 'bodyText', 'bodyHtml']) })
    expect(group('InboundEmail')).toMatchObject({ count: 2, keptFields: ['envelopeFrom'], why: { code: 'IMMUTABLE', words: KEPT_WHY_WORDS.IMMUTABLE } })
    // Her address is only among the To recipients: Cc (a colleague) stays as it is.
    expect(group('EmailOutbound')).toMatchObject({ count: 3, erasedFields: ['to', 'subject'] })
    expect(group('AuditLog')).toMatchObject({ count: 1, erasedFields: ['before', 'after'] })
    expect(preview.kept.filter((entry: Json) => ['Message', 'InboundEmail', 'EmailOutbound', 'AuditLog'].includes(entry.recordType))).toEqual([])

    await stepUp(h, desk.browser, desk.secret)
    const erased = await ok('POST', `/privacy/requests/${request.id}/erase`, { version: request.version, reason: 'Asked by mail (made up).', confirmName: 'Erika Prova' })
    expect(erased.erased).toMatchObject({ anonymised: 9, deleted: 0 })

    // The messages she wrote: no name, no text; the office note as it was.
    const message = (id: string) => one(`SELECT "authorName", "bodyText", "bodyHtml", "threadId" FROM "Message" WHERE id = $1`, [id])
    expect(await message(fromMail)).toEqual({ authorName: null, bodyText: '', bodyHtml: null, threadId })
    expect(await message(posted)).toEqual({ authorName: null, bodyText: '', bodyHtml: null, threadId })
    expect(await message(note)).toEqual({ authorName: 'Privacy desk', bodyText: 'Made-up note: Erika asked for a call.', bodyHtml: null, threadId })
    // Her mails: sender, name, subject, text and HTML blank; where they went and the envelope stay.
    for (const id of [matched, waiting]) {
      expect(await one(`SELECT "fromAddress", "fromName", subject, "bodyText", "bodyHtml", "envelopeFrom", status::text FROM "InboundEmail" WHERE id = $1`, [id])).toEqual({ fromAddress: null, fromName: null, subject: null, bodyText: null, bodyHtml: null, envelopeFrom: address, status: id === matched ? 'MATCHED' : 'TRIAGE' })
    }
    // The mails to her: her address and the subject blank, every other address stays; the queued one was stopped first.
    expect(await one(`SELECT "to", cc, subject, status::text FROM "EmailOutbound" WHERE id = $1`, [delivered])).toEqual({ to: ['', 'colleague.f54@example.com'], cc: [], subject: '', status: 'DELIVERED' })
    expect(await one(`SELECT "to", cc, subject, status::text, "lastError" FROM "EmailOutbound" WHERE id = $1`, [queued])).toEqual({ to: [''], cc: ['boss.f54@example.com'], subject: '', status: 'FAILED', lastError: expect.stringContaining('asked to be erased') })
    expect(await one(`SELECT "to", status::text FROM "EmailOutbound" WHERE id = $1`, [sending])).toEqual({ to: [''], status: 'SENT' })
    // Her record's history: her values null, the keys and the other row as they were; nothing removed.
    expect(await one(`SELECT before, after FROM "AuditLog" WHERE id = $1`, [named])).toEqual({ before: { name: null, email: null, roles: ['ORDERS'] }, after: { name: null, email: null, roles: ['ORDERS'] } })
    expect(await one(`SELECT before, after FROM "AuditLog" WHERE id = $1`, [plain])).toEqual({ before: { roles: [] }, after: { roles: ['ORDERS'] } })
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'PartyContact' AND "recordId" = $1`, [contactId])).n).toBe(2)
    // What was done is recorded (columns, never values), and the erasure's own audit row is kept with its reason.
    const records = await admin(`SELECT "recordType", method::text, "erasedFields", "keptFields" FROM "ErasureRecord" WHERE "dataRequestId" = $1 AND "recordType" <> 'PartyContact' ORDER BY "recordType", "recordId"`, [request.id])
    expect(records.length).toBe(8)
    expect(records.every((row) => row.method === 'ANONYMISED')).toBe(true)
    expect(records.filter((row) => row.recordType === 'InboundEmail').map((row) => row.keptFields)).toEqual([['envelopeFrom'], ['envelopeFrom']])
    const logged = await one(`SELECT reason, after::text AS after FROM "AuditLog" WHERE "recordType" = 'DataRequest' AND "recordId" = $1 AND action = 'privacy.erase'`, [request.id])
    expect(logged.reason).toBe('Asked by mail (made up).')
    expect(logged.after).not.toContain('Erika')
    expect((await ok('POST', `/privacy/requests/${request.id}/done`, { version: erased.request.version })).request.status).toBe('DONE')
  })

  it('keeps what they wrote and their history as they are while a legal hold keeps their record (an open service case: DISPUTE)', async () => {
    const partyId = seedUuid(NS, 'party:P1')
    const contactId = newId()
    await insertRow('PartyContact', { id: contactId, partyId, name: 'Ugo Prova', email: 'ugo.prova.f54@example.com', roles: ['ORDERS'] })
    await insertFixture('ServiceCase', { id: newId(), companyId: companyA, number: 'F54-SC-0001', kind: 'COMPLAINT', problem: 'Made-up complaint still open.', partyId, contactId })
    const row = newId()
    await insertRow('AuditLog', { id: row, companyId: companyA, audience: 'OFFICE', actorId: desk.userId, action: 'parties.updateContact', recordType: 'PartyContact', recordId: contactId, after: { name: 'Ugo Prova' }, requestId: `f54-${row}` })
    let request = (await ok('POST', '/privacy/requests', { companyId: companyA, personKind: 'CONTACT', personRecordId: contactId, kind: 'ERASURE' }, 201)).request
    request = (await ok('POST', `/privacy/requests/${request.id}/identity`, { version: request.version, how: 'In person (made up).' })).request
    const preview = await ok('GET', `/privacy/requests/${request.id}/erasure`)
    expect(preview.anonymised).toEqual([])
    expect(preview.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordType: 'PartyContact', why: { code: 'DISPUTE', words: KEPT_WHY_WORDS.DISPUTE } }),
        expect.objectContaining({ recordType: 'AuditLog', keptFields: ['before', 'after'], why: { code: 'DISPUTE', words: KEPT_WHY_WORDS.DISPUTE } }),
      ]),
    )
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
