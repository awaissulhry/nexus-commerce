import { createHash } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { useScanner } from '../../../platform/files/scan/service'

/**
 * Supplier documents and profile in the portal on the local stack (B-W2b-189; SCM-096, SCM-097): a throwaway PostgreSQL 17
 * database from the migrations (row-level security, the partner role's grants and the files and parties guards are real),
 * the real app with the office buyer who checks, and the supplier's people signed in to the portal by e-mail code (FAKE
 * mailbox, FAKE file store, no scanner). Every name, number and document is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/purchasing/portal-profile`.
 */

let h: Harness
let buyer: Browser
let anna: Browser
let vito: Browser
let otto: Browser
let annaId: string
let buyerId: string
const NS = 'sup-docs'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const P9 = newId()
const P3 = newId()
const leather = seedId('product:item:leather')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const FAKE_VAT = '12345670009'
const people = { anna: 'anna.admin@tannery-p2.example', vito: 'vito.quality@tannery-p2.example', otto: 'otto.admin@other-p9.example' }
const today = () => businessDate(h.clock.now())

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `sdp-${label}-${++counter}-${newId()}`
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up test document: ${text}`)

async function call(browser: Browser, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  // The test browser names GET and POST; inject sends a PATCH the same way (CSRF and cookies included).
  const answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  return { status: answer.status, body: answer.body as Json }
}
async function as(browser: Browser, method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!.replace('.', ' '), locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'SUPPLIER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: tenant, key: roleKey } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

/** A PO of black leather for P2, sent. */
async function sentOrder(): Promise<Json> {
  let draft = (await as(buyer, 'POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, incoterms: 'EXW Seedville' }, 201)).order
  draft = (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/lines`, { version: draft.version, itemId: leather, itemColourId: leatherBLK, quantity: '105', uom: 'FT2', needDate: addDays(today(), 30) }, 201)).order
  return (await as(buyer, 'POST', `/purchasing/orders/${draft.id}/send`, { version: draft.version })).order
}

/** The supplier sends a document: announce, PUT the bytes, confirm. */
async function sendDocument(browser: Browser, body: Buffer, fields: Json): Promise<Json> {
  const announced = await as(browser, 'POST', '/portal/supplier-documents', { originalName: 'Document.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body), ...fields }, 201)
  expect(announced.file.status).toBe('PENDING_UPLOAD')
  expect((await h.app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await as(browser, 'POST', `/portal/supplier-documents/${announced.file.id}/complete`)
  return { ...announced, ...done }
}

/** B-W2b-F13a: the upload's and the request's own rows (W2b schema wave 23). */
const uploadRow = (fileId: string) =>
  one('SELECT status, "uploadedById", "uploadedByName", "documentNumber", "issuedOn"::text AS "issuedOn", "expiresOn"::text AS "expiresOn", "lotCodes", "receivedAt" IS NOT NULL AS received, "decidedById", "decidedByName", "acceptedCategory", "acceptedExpiresOn"::text AS "acceptedExpiresOn", "documentFileId", "refuseReason", "taskId", "replacesFileId", version FROM "SupplierDocumentUpload" WHERE "fileId" = $1', [fileId])
const requestRow = (id: string) => one('SELECT status, "requestedById", "requestedByName", summary, "decidedAt" IS NOT NULL AS decided, "decidedById", "decidedByName", "refuseReason", version FROM "PartyChangeRequest" WHERE id = $1', [id])
const fileRow = (id: string) => one('SELECT id, status, visibility::text[] AS visibility, "partyId", category, "expiresOn", "seriesId", "versionNo", "supersededAt", "sourceFileId", version FROM "StoredFile" WHERE id = $1', [id])
const outbox = (type: string) => admin<{ subject: string; payload: Json }>('SELECT subject, payload FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt", id', [type])
const leaks = (body: unknown): string[] => [/price"\s*:/i, /unitPrice/i, /amount/i, /internalNote/, /createdById/, /reviewNote/].filter((pattern) => pattern.test(JSON.stringify(body))).map(String)

beforeAll(async () => {
  h = await startHarness('sup_docs')
  h.clock.set(new Date())
  useScanner(null)
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  await portalWorld(h, seedTenant)
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => {
    await client.portalSettings.create({ data: { id: P2, partyId: P2, portalOn: true }, select: { id: true } })
    await client.party.create({ data: { id: P9, code: `P${P9.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Other Supplier S.r.l.', roles: ['SUPPLIER'] }, select: { id: true } })
    await client.portalSettings.create({ data: { id: P9, partyId: P9, portalOn: true }, select: { id: true } })
    await client.party.create({ data: { id: P3, code: `P${P3.slice(-6)}`, kind: 'ORGANISATION', legalName: 'Prospect Supplier S.r.l.', roles: ['SUPPLIER'], status: 'PROSPECT', companyId: companyA }, select: { id: true } })
  })
  // Anna is P2's admin and may upload; Vito handles quality without the upload capability; Otto is another supplier's admin.
  annaId = await partnerPerson(people.anna, P2, ['supplier-admin', 'partner-upload'])
  await partnerPerson(people.vito, P2, ['supplier-quality'])
  await partnerPerson(people.otto, P9, ['supplier-admin', 'partner-upload'])
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyerId = (await one<{ id: string }>('SELECT id FROM "User" WHERE email = $1', [buyerUser.email])).id
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  freshGuard(h)
  anna = await signedIn(people.anna)
  vito = await signedIn(people.vito)
  otto = await signedIn(people.otto)
}, 240_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useScanner(undefined)
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('documents we ask for, and what the supplier sends (SCM-096)', () => {
  let order: Json
  let certificate: Json

  it('asks for what the company rules need from the supplier, with why and by when', async () => {
    await as(buyer, 'POST', '/files/required-rules', { companyId: companyA, recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK' }, 201)
    await as(buyer, 'POST', '/files/required-rules', { companyId: companyA, recordType: 'PurchaseOrder', category: 'TEST_REPORT', beforeStatus: 'RECEIVED', partyRole: 'SUPPLIER', level: 'WARN' }, 201)
    order = await sentOrder()
    const page = await as(anna, 'GET', '/portal/supplier-documents')
    expect(page.mayUpload).toBe(true)
    expect(page.documents).toEqual([])
    const certificateRow = page.requested.find((row: Json) => row.category === 'SUPPLIER_CERTIFICATE')
    // A company-wide document is asked once, on the supplier's own record, for the orders that need it.
    expect(certificateRow).toMatchObject({ source: 'RULE', record: { type: 'Party', id: P2 }, level: 'BLOCK', state: 'MISSING', waiting: false, reason: `Needed before we confirm purchase order ${order.number}.` })
    expect(certificateRow.forRecords.map((record: Json) => record.id)).toContain(order.id)
    expect(page.requested.find((row: Json) => row.category === 'TEST_REPORT' && row.record.id === order.id)).toMatchObject({ source: 'RULE', record: { type: 'PurchaseOrder', id: order.id }, level: 'WARN', state: 'MISSING' })
    expect(leaks(page)).toEqual([])
    // Home counts what we ask for.
    expect((await as(anna, 'GET', '/portal/home')).counts.find((count: Json) => count.key === 'supplier_documents.requested')?.value).toBe(page.counts.requested)
  })

  it('REFUSED: a person without the upload capability, another supplier reading ours, a document already expired', async () => {
    expect((await as(vito, 'GET', '/portal/supplier-documents')).mayUpload).toBe(false)
    const body = pdf('vito')
    const refused = await call(vito, 'POST', '/portal/supplier-documents', { category: 'SUPPLIER_CERTIFICATE', originalName: 'Cert.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body) })
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toMatch(/ask your admin/)
    const theirs = await as(otto, 'GET', '/portal/supplier-documents')
    expect(theirs.requested.filter((row: Json) => row.forRecords.some((record: Json) => record.id === order.id))).toEqual([])
    const old = await call(anna, 'POST', '/portal/supplier-documents', { category: 'SUPPLIER_CERTIFICATE', expiresOn: addDays(today(), -1), originalName: 'Old.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: sha256(pdf('old')) })
    expect(old.status).toBe(400)
    // Another supplier's order is not a record the supplier may send for.
    const other = await call(otto, 'POST', '/portal/supplier-documents', { category: 'TEST_REPORT', recordType: 'PurchaseOrder', recordId: order.id, originalName: 'X.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: sha256(pdf('x')) })
    expect(other.status).toBe(404)
  })

  it('takes the upload unshared, waiting for our check; it does not count for the rules yet', async () => {
    certificate = await sendDocument(anna, pdf('iso 9001'), { category: 'SUPPLIER_CERTIFICATE', issuer: 'Made-up Cert Body', number: 'ISO-0001', issuedOn: addDays(today(), -10), expiresOn: addDays(today(), 400) })
    expect(certificate.state).toBe('WAITING')
    expect(certificate.record).toMatchObject({ type: 'Party', id: P2 })
    expect(await fileRow(certificate.file.id)).toMatchObject({ status: 'AVAILABLE', visibility: ['OFFICE'], partyId: null, category: null })
    const page = await as(anna, 'GET', '/portal/supplier-documents')
    expect(page.documents).toEqual([expect.objectContaining({ fileId: certificate.file.id, state: 'WAITING', category: 'SUPPLIER_CERTIFICATE', issuer: 'Made-up Cert Body', number: 'ISO-0001', canReplace: false })])
    expect(page.requested.find((row: Json) => row.category === 'SUPPLIER_CERTIFICATE').waiting).toBe(true)
    // The supplier's own scope cannot read the file (unshared): its download is not found.
    expect((await call(anna, 'GET', `/files/${certificate.file.id}/download`)).status).toBe(404)
    const documents = await as(buyer, 'GET', `/files/documents?recordType=PurchaseOrder&recordId=${order.id}`)
    expect(documents.moves.find((move: Json) => move.toStatus === 'CONFIRMED').requirements[0]).toMatchObject({ category: 'SUPPLIER_CERTIFICATE', reason: 'MISSING' })
    expect((await outbox('supplier_document.uploaded')).map((row) => row.payload)).toContainEqual(expect.objectContaining({ fileId: certificate.file.id, partyId: P2, category: 'SUPPLIER_CERTIFICATE' }))
    // B-W2b-F13a: a row of its own, WAITING, the file arrived (announce at version 1, received + 1); the audit rows stay as history.
    expect(await uploadRow(certificate.file.id)).toMatchObject({ status: 'WAITING', uploadedById: annaId, uploadedByName: 'anna admin', documentNumber: 'ISO-0001', issuedOn: addDays(today(), -10), expiresOn: addDays(today(), 400), received: true, decidedById: null, version: 2 })
    expect((await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'Party' AND "recordId" = $1 AND action LIKE 'supplierDocuments.%' ORDER BY at, id`, [P2])).map((row) => row.action)).toEqual(['supplierDocuments.upload', 'supplierDocuments.received'])
  })

  it('shows the buyer what waits (the list and Home › Approvals)', async () => {
    const list = await as(buyer, 'GET', `/purchasing/supplier-documents?partyId=${P2}`)
    expect(list.rows).toEqual([expect.objectContaining({ fileId: certificate.file.id, state: 'WAITING', sentBy: 'anna admin', issuer: 'Made-up Cert Body', mayDecide: true, party: expect.objectContaining({ id: P2 }) })])
    const todayRows = await as(buyer, 'GET', '/home/today?limit=200&kind=SUPPLIER_DOCUMENT')
    expect(todayRows.items.map((item: Json) => [item.kind, item.record.id])).toContainEqual(['SUPPLIER_DOCUMENT', P2])
  })

  it('accepts it (kind, until when): shared back as seen, the rule met; a second decision and a stale version are refused', async () => {
    const version = (await fileRow(certificate.file.id)).version
    expect((await call(buyer, 'POST', `/purchasing/supplier-documents/${certificate.file.id}/accept`, { category: 'SUPPLIER_CERTIFICATE', expiresOn: addDays(today(), 400), version: version + 5 })).status).toBe(409)
    const accepted = await as(buyer, 'POST', `/purchasing/supplier-documents/${certificate.file.id}/accept`, { category: 'SUPPLIER_CERTIFICATE', expiresOn: addDays(today(), 400), version })
    expect(accepted).toMatchObject({ state: 'ACCEPTED', documentFileId: certificate.file.id })
    expect(await fileRow(certificate.file.id)).toMatchObject({ visibility: ['OFFICE', 'PARTNER'], partyId: P2, category: 'SUPPLIER_CERTIFICATE' })
    expect((await call(buyer, 'POST', `/purchasing/supplier-documents/${certificate.file.id}/accept`, { category: 'SUPPLIER_CERTIFICATE', expiresOn: null, version: version + 1 })).status).toBe(409)
    const documents = await as(buyer, 'GET', `/files/documents?recordType=PurchaseOrder&recordId=${order.id}`)
    expect(documents.moves.find((move: Json) => move.toStatus === 'CONFIRMED').requirements[0]).toMatchObject({ reason: 'MET', fileId: certificate.file.id })
    const page = await as(anna, 'GET', '/portal/supplier-documents')
    expect(page.documents).toEqual([expect.objectContaining({ fileId: certificate.file.id, state: 'ACCEPTED', daysLeft: 400, canReplace: true })])
    expect(page.requested.find((row: Json) => row.category === 'SUPPLIER_CERTIFICATE')).toBeUndefined()
    expect((await call(anna, 'GET', `/files/${certificate.file.id}/download`)).status).toBe(200)
    expect((await outbox('supplier_document.accepted')).map((row) => row.payload)).toContainEqual(expect.objectContaining({ fileId: certificate.file.id, documentFileId: certificate.file.id }))
    // B-W2b-F13a: the decision on the upload's row, once.
    expect(await uploadRow(certificate.file.id)).toMatchObject({ status: 'ACCEPTED', decidedById: buyerId, decidedByName: expect.any(String), acceptedCategory: 'SUPPLIER_CERTIFICATE', acceptedExpiresOn: addDays(today(), 400), documentFileId: certificate.file.id, refuseReason: null, version: 3 })
  })

  it('refuses a test report with the reason; the supplier is asked again and its next upload answers it', async () => {
    const report = await sendDocument(anna, pdf('cr vi'), { category: 'TEST_REPORT', recordType: 'PurchaseOrder', recordId: order.id, lots: ['2231'] })
    const version = (await fileRow(report.file.id)).version
    expect((await call(buyer, 'POST', `/purchasing/supplier-documents/${report.file.id}/refuse`, { reason: ' ', version })).status).toBe(400)
    const refused = await as(buyer, 'POST', `/purchasing/supplier-documents/${report.file.id}/refuse`, { reason: 'The report is for dye batch 2230, not 2231.', version })
    expect(await uploadRow(report.file.id)).toMatchObject({ status: 'REFUSED', decidedById: buyerId, refuseReason: 'The report is for dye batch 2230, not 2231.', acceptedCategory: null, documentFileId: null, lotCodes: ['2231'] })
    const task = await one('SELECT status, "sourceKey", "recordId", "askedByName" FROM "PartnerTask" WHERE id = $1', [refused.taskId])
    expect(task).toMatchObject({ status: 'OPEN', sourceKey: `SupplierDocument:${report.file.id}`, recordId: order.id })
    expect(await fileRow(report.file.id)).toMatchObject({ visibility: ['OFFICE'], partyId: null })
    const page = await as(anna, 'GET', '/portal/supplier-documents')
    expect(page.documents).toContainEqual(expect.objectContaining({ fileId: report.file.id, state: 'REJECTED', reason: 'The report is for dye batch 2230, not 2231.' }))
    expect(page.requested).toContainEqual(expect.objectContaining({ source: 'REFUSED', taskId: refused.taskId, category: 'TEST_REPORT' }))
    const again = await sendDocument(anna, pdf('cr vi 2231'), { category: 'TEST_REPORT', taskId: refused.taskId, lots: ['2231'] })
    expect(again.record).toMatchObject({ type: 'PurchaseOrder', id: order.id })
    expect(await one('SELECT status, "doneById" IS NOT NULL AS done FROM "PartnerTask" WHERE id = $1', [refused.taskId])).toMatchObject({ status: 'DONE', done: true })
    expect(await uploadRow(again.file.id)).toMatchObject({ status: 'WAITING', taskId: refused.taskId, received: true })
  })

  it('a replacement becomes the next version of the accepted document once accepted (the old one kept)', async () => {
    const next = await sendDocument(anna, pdf('iso 9001 renewed'), { category: 'SUPPLIER_CERTIFICATE', replacesFileId: certificate.file.id, expiresOn: addDays(today(), 800) })
    expect((await as(buyer, 'GET', `/purchasing/supplier-documents?partyId=${P2}`)).rows.find((row: Json) => row.fileId === next.file.id).replaces).toMatchObject({ fileId: certificate.file.id, current: true })
    const accepted = await as(buyer, 'POST', `/purchasing/supplier-documents/${next.file.id}/accept`, { category: 'SUPPLIER_CERTIFICATE', expiresOn: addDays(today(), 800), version: (await fileRow(next.file.id)).version })
    expect(accepted.documentFileId).not.toBe(next.file.id)
    expect(await uploadRow(next.file.id)).toMatchObject({ status: 'ACCEPTED', replacesFileId: certificate.file.id, documentFileId: accepted.documentFileId })
    expect(await fileRow(accepted.documentFileId)).toMatchObject({ seriesId: certificate.file.id, versionNo: 2, sourceFileId: next.file.id, partyId: P2, category: 'SUPPLIER_CERTIFICATE', supersededAt: null })
    expect((await fileRow(certificate.file.id)).supersededAt).not.toBeNull()
    const page = await as(anna, 'GET', '/portal/supplier-documents')
    expect(page.documents.filter((row: Json) => row.category === 'SUPPLIER_CERTIFICATE')).toEqual([expect.objectContaining({ fileId: accepted.documentFileId, uploadFileId: next.file.id, state: 'ACCEPTED', daysLeft: 800 })])
  })

  it('a party becomes active only with the documents a BLOCK rule needs (B-W2b-177 assertRequiredDocuments)', async () => {
    await as(buyer, 'POST', '/files/required-rules', { companyId: companyA, recordType: 'Party', category: 'DECLARATION', beforeStatus: 'ACTIVE', partyRole: 'SUPPLIER', level: 'BLOCK' }, 201)
    const party = await one('SELECT version FROM "Party" WHERE id = $1', [P3])
    const refused = await call(buyer, 'POST', `/parties/${P3}/activate`, { version: party.version })
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/declaration/)
    // P2 is asked for it too: on its own record.
    expect((await as(anna, 'GET', '/portal/supplier-documents')).requested).toContainEqual(expect.objectContaining({ source: 'RULE', category: 'DECLARATION', record: expect.objectContaining({ type: 'Party', id: P2 }), level: 'BLOCK' }))
  })
})

describe('the supplier profile: changes the buyer checks (SCM-097)', () => {
  let contactId: string

  it('shows the company as we hold it; the admin may send changes, the quality person may not', async () => {
    const party = await one('SELECT version FROM "Party" WHERE id = $1', [P2])
    expect(party).toBeTruthy()
    await as(buyer, 'POST', `/parties/${P2}/contacts`, { name: 'Gina Ordini', email: 'gina@tannery-p2.example', roles: ['ORDERS'] }, 201)
    const profile = await as(anna, 'GET', '/portal/supplier-profile')
    expect(profile.mayChange).toBe(true)
    expect(profile.company.legalName).toBeTruthy()
    contactId = profile.contacts.find((row: Json) => row.email === 'gina@tannery-p2.example').id
    expect(leaks(profile)).toEqual([])
    expect((await as(vito, 'GET', '/portal/supplier-profile')).mayChange).toBe(false)
    expect((await call(vito, 'POST', '/portal/supplier-profile/changes', { contacts: [{ op: 'REMOVE', contactId, version: 1 }] })).status).toBe(403)
  })

  it('a request waits for the buyer: nothing changes until the yes; a second change of the same contact is refused', async () => {
    const contact = await one('SELECT version, phone FROM "PartyContact" WHERE id = $1', [contactId])
    const sent = await as(
      anna,
      'POST',
      '/portal/supplier-profile/changes',
      {
        addresses: [{ op: 'ADD', address: { kinds: ['PICKUP'], line1: 'Via delle Concerie 7', postalCode: '36071', city: 'Arzignano', province: 'VI', country: 'IT' } }],
        contacts: [{ op: 'CHANGE', contactId, version: contact.version, contact: { phone: '+39 0444 000111' } }],
        note: 'New warehouse.',
      },
      201,
    )
    expect(sent.request).toMatchObject({ state: 'OPEN', summary: '1 address and 1 contact' })
    expect(await requestRow(sent.request.requestId)).toMatchObject({ status: 'OPEN', requestedById: annaId, requestedByName: 'anna admin', summary: '1 address and 1 contact', decided: false, version: 1 })
    expect(sent.request.changes.map((change: Json) => change.sentence)).toContain('Contact Gina Ordini: phone — → +39 0444 000111.')
    expect((await one('SELECT phone FROM "PartyContact" WHERE id = $1', [contactId])).phone).toBe(contact.phone)
    expect((await call(anna, 'POST', '/portal/supplier-profile/changes', { contacts: [{ op: 'REMOVE', contactId, version: contact.version }] })).status).toBe(409)
    expect((await call(anna, 'POST', '/portal/supplier-profile/changes', { addresses: [{ op: 'ADD', address: { kinds: ['BILL_TO'], line1: 'Via X 1', postalCode: '36071', city: 'Arzignano', province: 'VI', country: 'IT' } }] })).status).toBe(400)
    const profile = await as(anna, 'GET', '/portal/supplier-profile')
    expect(profile.pending).toHaveLength(1)
    expect(profile.contacts.find((row: Json) => row.id === contactId).waiting).toBe(true)
    // Home › Approvals and the buyer's list.
    expect((await as(buyer, 'GET', '/home/today?limit=200&kind=SUPPLIER_CHANGE')).items.map((item: Json) => item.record.id)).toContain(P2)
    const list = await as(buyer, 'GET', `/purchasing/supplier-changes?partyId=${P2}`)
    expect(list.requests).toEqual([expect.objectContaining({ requestId: sent.request.requestId, state: 'OPEN', party: expect.objectContaining({ id: P2 }) })])
    // The yes applies it; a second yes is refused.
    const approved = await as(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/approve`)
    expect(approved.request).toMatchObject({ state: 'APPROVED', decidedBy: expect.any(String) })
    expect(await requestRow(sent.request.requestId)).toMatchObject({ status: 'APPROVED', decided: true, decidedById: buyerId, refuseReason: null, version: 2 })
    expect((await one('SELECT phone, version FROM "PartyContact" WHERE id = $1', [contactId])).phone).toBe('+39 0444 000111')
    expect(await admin('SELECT kinds::text[] AS kinds FROM "PartyAddress" WHERE "partyId" = $1 AND line1 = $2 AND status = $3', [P2, 'Via delle Concerie 7', 'ACTIVE'])).toEqual([{ kinds: ['PICKUP'] }])
    expect((await call(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/approve`)).status).toBe(409)
    expect((await outbox('supplier_profile.change_decided')).map((row) => row.payload)).toContainEqual({ requestId: sent.request.requestId, partyId: P2, outcome: 'APPROVED' })
  })

  it('stops an approval when the row changed after it was sent; refused with the reason; withdrawn by the supplier', async () => {
    const contact = await one('SELECT version FROM "PartyContact" WHERE id = $1', [contactId])
    const sent = await as(anna, 'POST', '/portal/supplier-profile/changes', { contacts: [{ op: 'CHANGE', contactId, version: contact.version, contact: { name: 'Gina Rossi' } }] }, 201)
    await as(buyer, 'PATCH', `/parties/${P2}/contacts/${contactId}`, { version: contact.version, phone: '+39 0444 000222' })
    const stale = await call(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/approve`)
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toMatch(/changed after the supplier sent this/)
    // The stopped approval changed nothing: the request still OPEN at version 1.
    expect(await requestRow(sent.request.requestId)).toMatchObject({ status: 'OPEN', version: 1 })
    expect((await call(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/refuse`, { reason: 'x' })).status).toBe(400)
    const refused = await as(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/refuse`, { reason: 'We changed the phone meanwhile: send it again.' })
    expect(refused.request).toMatchObject({ state: 'REFUSED', reason: 'We changed the phone meanwhile: send it again.' })
    expect(await requestRow(sent.request.requestId)).toMatchObject({ status: 'REFUSED', decidedById: buyerId, refuseReason: 'We changed the phone meanwhile: send it again.', version: 2 })
    expect((await as(anna, 'GET', '/portal/supplier-profile')).decided[0]).toMatchObject({ requestId: sent.request.requestId, state: 'REFUSED' })
    const fresh = await one('SELECT version FROM "PartyContact" WHERE id = $1', [contactId])
    const third = await as(anna, 'POST', '/portal/supplier-profile/changes', { contacts: [{ op: 'REMOVE', contactId, version: fresh.version }] }, 201)
    expect((await as(anna, 'POST', `/portal/supplier-profile/changes/${third.request.requestId}/withdraw`)).request.state).toBe('WITHDRAWN')
    expect(await requestRow(third.request.requestId)).toMatchObject({ status: 'WITHDRAWN', decided: true, decidedById: null, decidedByName: null, version: 2 })
    expect((await call(anna, 'POST', `/portal/supplier-profile/changes/${third.request.requestId}/withdraw`)).status).toBe(409)
    expect((await call(buyer, 'POST', `/purchasing/supplier-changes/${third.request.requestId}/approve`)).status).toBe(409)
    // Another supplier never reaches P2's requests.
    expect((await call(otto, 'POST', `/portal/supplier-profile/changes/${sent.request.requestId}/withdraw`)).status).toBe(404)
    expect((await one('SELECT status FROM "PartyContact" WHERE id = $1', [contactId])).status).toBe('ACTIVE')
  })

  it('W2b wave 23: the website — the office sets it in words, the supplier asks to change it, the buyer approves it', async () => {
    // The office's party record (parties contract): an address without http(s) is refused in words; a good one is kept.
    const record = (await as(buyer, 'GET', `/parties/${P2}`)).party
    expect(record.website).toBeNull()
    const bad = await call(buyer, 'PATCH', `/parties/${P2}`, { version: record.version, website: 'www.tannery-p2.example' })
    expect(bad.status).toBe(400)
    expect(JSON.stringify(bad.body)).toMatch(/starting with http/)
    expect((await as(buyer, 'PATCH', `/parties/${P2}`, { version: record.version, website: 'https://old.tannery-p2.example' })).party.website).toBe('https://old.tannery-p2.example')
    // The supplier reads it and asks for a new one: nothing changes until the yes; a second request for it is refused.
    let profile = await as(anna, 'GET', '/portal/supplier-profile')
    expect(profile.company).toMatchObject({ website: 'https://old.tannery-p2.example', waiting: false })
    expect((await call(anna, 'POST', '/portal/supplier-profile/changes', { company: { website: 'tannery-p2' } })).status).toBe(400)
    const sent = await as(anna, 'POST', '/portal/supplier-profile/changes', { company: { website: 'https://www.tannery-p2.example' } }, 201)
    expect(sent.request).toMatchObject({ state: 'OPEN', summary: 'the website', changes: [{ target: 'COMPANY', op: 'CHANGE', sentence: 'Website https://old.tannery-p2.example → https://www.tannery-p2.example.' }] })
    expect((await call(anna, 'POST', '/portal/supplier-profile/changes', { company: { website: 'https://other.tannery-p2.example' } })).status).toBe(409)
    profile = await as(anna, 'GET', '/portal/supplier-profile')
    expect(profile.company).toMatchObject({ website: 'https://old.tannery-p2.example', waiting: true })
    // The office changed it meanwhile: the approval stops in words (the request stays OPEN); set back, it applies.
    const moved = (await one('SELECT version FROM "Party" WHERE id = $1', [P2])).version
    await as(buyer, 'PATCH', `/parties/${P2}`, { version: moved, website: 'https://meanwhile.tannery-p2.example' })
    const stale = await call(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/approve`)
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toMatch(/the website changed after the supplier sent this/)
    await as(buyer, 'PATCH', `/parties/${P2}`, { version: moved + 1, website: 'https://old.tannery-p2.example' })
    const approved = await as(buyer, 'POST', `/purchasing/supplier-changes/${sent.request.requestId}/approve`)
    expect(approved.request).toMatchObject({ state: 'APPROVED' })
    expect((await one('SELECT website FROM "Party" WHERE id = $1', [P2])).website).toBe('https://www.tannery-p2.example')
    expect((await outbox('party.updated')).map((row) => row.payload)).toContainEqual(expect.objectContaining({ partyId: P2, fields: ['website'] }))
    expect((await as(anna, 'GET', '/portal/supplier-profile')).company).toMatchObject({ website: 'https://www.tannery-p2.example', waiting: false })
  })
})
