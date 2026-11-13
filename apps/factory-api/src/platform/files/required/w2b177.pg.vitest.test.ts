import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/files/expiry/rules'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { addTenant, addUser, startHarness, type Harness, type TestTenant } from '../../auth/sessions/testing/harness'
import { fanOut } from '../../notifications/fan-out'
import { systemContext } from '../../outbox/system'
import { prepareFileCopy, recordGeneratedFile } from '../files'
import { useScanner } from '../scan/service'
import { processFiles } from '../service'
import { runExpiryReminders } from '../expiry/remind'
import { assertRequiredDocuments } from './check'

// ---- B-W2b-F43: the clock is fixed at Friday 13 Nov 2026 09:00 UTC (10:00 at the plant), in the seeds' week, and runs on from
// there: the expectations read the seeds' fixed days and failed once those days passed (a fake clock on 2026-12-07 or 2027-01-15
// found it). The routes read the same clock (serverClock); the office sign-in keeps its own movable clock.
vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-13T09:00:00.000Z'), shouldAdvanceTime: true })
afterAll(() => vi.useRealTimers())
// ---- end B-W2b-F43

/**
 * B-W2b-177 on the local stack: required documents per record type before a status move (COL-048), a document's type and
 * expiry with the reminders 30 and 7 days before — the record's owner told, the partner asked for a new version (COL-049) —,
 * markup on a picture (a new version) and on a PDF page (an overlay) and the Versions pop-up's history (COL-055, COL-046).
 * A throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the files guards real),
 * the real app and routes with test sessions holding the template grants, FAKE file store, the fan-out run as the worker
 * would on the outbox rows. Run with `node scripts/factory/run-pg-tests.mjs platform/files`.
 */

let h: Harness
let app: FastifyInstance
let tenant: TestTenant
let company: string
let site: string
const supplier = newId()
const purchaseOrder = newId()
const PEOPLE: Record<string, string> = {}

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up test file: ${text}`)
// A made-up 1×1 PNG (the browser sends the marked picture; its bytes are not read here).
const png = (seed: number): Buffer => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'), Buffer.from([seed])])

function grantOf(key: string): Grant {
  const template = templateOf(key)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const SESSIONS: Record<string, () => SessionContext> = {
  admin: () => ({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE.admin!, companyId: company, grants: [grantOf('admin')] }),
  buyer: () => ({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE.buyer!, companyId: company, grants: [grantOf('buyer')] }),
  sales: () => ({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE.sales!, companyId: company, grants: [grantOf('sales')] }),
  reader: () => ({ audience: 'office', tenantId: tenant.id, actorId: PEOPLE.reader!, companyId: company, grants: [{ permissions: ['files.read', 'documents.view'], companies: 'all', sites: 'all', parties: 'all' }] }),
}

async function call(person: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: response.body ? (response.json() as Json) : {} }
}
async function ok(person: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
const send = (upload: Json, body: Buffer) => app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })
async function uploaded(body: Buffer, fields: Record<string, unknown>, person = 'buyer'): Promise<Json> {
  const { file, upload } = await ok(person, 'POST', '/files', { companyId: company, kind: 'DOCUMENT', originalName: 'Doc.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body), ...fields }, 201)
  expect((await send(upload, body)).statusCode).toBe(200)
  return (await ok(person, 'POST', `/files/${file.id}/complete`)).file
}
const today = () => businessDate(h.clock.now())
const versionOf = async (fileId: string): Promise<number> => (await admin<{ version: number }>('SELECT version FROM "StoredFile" WHERE id = $1', [fileId]))[0]!.version
const tag = (person: string, fileId: string, body: Record<string, unknown>) => call(person, 'PUT', `/files/${fileId}/document`, body)
const documents = (recordType: string, recordId: string) => ok('buyer', 'GET', `/files/documents?recordType=${recordType}&recordId=${recordId}`)

let mark = new Date(0)
async function fanOutSince(types: readonly string[]): Promise<number> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = ANY($2) AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [tenant.id, types, mark])
  let made = 0
  for (const row of rows) {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload }
    made += await fanOut(callerFor(h.database, systemContext(tenant.id, `test-${row.id}`)), envelope)
  }
  mark = new Date()
  return made
}
const remind = () => runExpiryReminders({ database: h.database, log: { info() {}, warn() {}, error() {} } as never, clock: h.clock })

beforeAll(async () => {
  h = await startHarness('files_w2b177')
  useScanner(null)
  tenant = await addTenant(h, 'w2b177')
  company = tenant.companies[0]!.id
  PEOPLE.admin = (await addUser(h, tenant, { email: 'admin.177@example.com', role: 'admin' })).id
  PEOPLE.buyer = (await addUser(h, tenant, { email: 'buyer.177@example.com', role: 'buyer' })).id
  PEOPLE.sales = (await addUser(h, tenant, { email: 'sales.177@example.com', role: 'sales' })).id
  PEOPLE.reader = (await addUser(h, tenant, { email: 'reader.177@example.com', role: 'read_only' })).id
  site = newId()
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'S0', 'S0', 'PLANT')`, [site, tenant.id, company])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant.id])
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'FORN-177', 'ORGANISATION', 'Conceria Esempio S.r.l.', '{SUPPLIER}')`, [supplier, tenant.id, company])
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, 'PO-177-1', $5, current_date, $6)`, [purchaseOrder, tenant.id, company, site, supplier, PEOPLE.buyer])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, clock: h.clock, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 600_000)

afterAll(async () => {
  useScanner(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('required documents (COL-048)', () => {
  let block: Json
  it('keeps one active rule per record type, document, status and party role; switched off, never deleted', async () => {
    const listed = await ok('buyer', 'GET', `/files/required-rules?companyId=${company}`)
    expect(listed.rules).toEqual([])
    expect(listed.mayChange).toEqual([company])
    expect(listed.recordTypes.find((type: Json) => type.recordType === 'PurchaseOrder').statuses).toContain('CONFIRMED')
    block = (await ok('buyer', 'POST', '/files/required-rules', { companyId: company, recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK' }, 201)).rule
    expect(block).toMatchObject({ active: true, level: 'BLOCK', version: 1 })
    // REFUSED: a second active rule of the same key; a status the record type does not have; nobody without the right.
    const twice = await call('buyer', 'POST', '/files/required-rules', { companyId: company, recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'WARN' })
    expect(twice.status).toBe(409)
    expect(twice.body.error.message).toMatch(/already asks for this document/)
    const wrong = await call('buyer', 'POST', '/files/required-rules', { companyId: company, recordType: 'PurchaseOrder', category: 'OTHER', beforeStatus: 'POSTED', partyRole: null, level: 'WARN' })
    expect(wrong.status).toBe(400)
    expect(wrong.body.error.issues.map((issue: Json) => issue.path)).toEqual(['body/beforeStatus', 'body/category'])
    expect((await call('sales', 'POST', '/files/required-rules', { companyId: company, recordType: 'PurchaseOrder', category: 'DECLARATION', beforeStatus: 'CONFIRMED', partyRole: null, level: 'WARN' })).status).toBe(403)
    // Warns instead, then off, a new one with the same key, and the old one cannot come back on beside it.
    const warned = (await ok('buyer', 'PATCH', `/files/required-rules/${block.id}`, { level: 'WARN', version: 1 })).rule
    expect((await call('buyer', 'PATCH', `/files/required-rules/${block.id}`, { level: 'BLOCK', version: 1 })).status).toBe(409)
    const off = (await ok('buyer', 'PATCH', `/files/required-rules/${block.id}`, { active: false, version: warned.version })).rule
    block = (await ok('buyer', 'POST', '/files/required-rules', { companyId: company, recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK' }, 201)).rule
    expect((await call('buyer', 'PATCH', `/files/required-rules/${off.id}`, { active: true, version: off.version })).status).toBe(409)
    await ok('buyer', 'POST', '/files/required-rules', { companyId: company, recordType: 'PurchaseOrder', category: 'DECLARATION', beforeStatus: 'CONFIRMED', partyRole: null, level: 'WARN' }, 201)
    expect((await ok('reader', 'GET', '/files/required-rules')).mayChange).toEqual([])
    expect((await admin('SELECT count(*)::int AS n FROM "RequiredDocumentRule" WHERE "tenantId" = $1', [tenant.id]))[0]!.n).toBe(3)
  })

  it("says before the move what a purchase order lacks, counts the supplier's own certificate, and refuses the move in its command", async () => {
    let read = await documents('PurchaseOrder', purchaseOrder)
    expect(read.status).toBe('DRAFT')
    expect(read.moves).toEqual([{ toStatus: 'CONFIRMED', requirements: expect.any(Array) }])
    expect(read.moves[0].requirements.map((r: Json) => [r.category, r.level, r.reason])).toEqual([
      ['SUPPLIER_CERTIFICATE', 'BLOCK', 'MISSING'],
      ['DECLARATION', 'WARN', 'MISSING'],
    ])
    const caller = callerFor(h.database, { ...SESSIONS.buyer!(), requestId: newId() } as never)
    const check = () => command(caller, { name: 'purchasing.testConfirm', input: { purchaseOrder } }, async (tools) => {
      const answer = await assertRequiredDocuments(tools, { recordType: 'PurchaseOrder', recordId: purchaseOrder, toStatus: 'CONFIRMED' })
      tools.audit({ recordType: 'PurchaseOrder', recordId: purchaseOrder, after: { warnings: answer.sentences } })
      return answer
    })
    await expect(check()).rejects.toThrow('This purchase order cannot move to Confirmed yet. A supplier certificate is needed before Confirmed: none is on file.')
    // The supplier's certificate, kept once on the supplier and shared with its portal; tagged with its date.
    const certificate = await uploaded(pdf('LWG certificate'), { recordType: 'Party', recordId: supplier, originalName: 'LWG certificate.pdf', visibility: ['OFFICE', 'PARTNER'], partyId: supplier }, 'admin')
    const tagged = await tag('buyer', certificate.id, { category: 'SUPPLIER_CERTIFICATE', expiresOn: addDays(today(), -1), version: await versionOf(certificate.id) })
    expect(tagged.status, JSON.stringify(tagged.body)).toBe(200)
    expect(tagged.body.document).toMatchObject({ category: 'SUPPLIER_CERTIFICATE', expiryState: 'EXPIRED', daysLeft: -1 })
    read = await documents('PurchaseOrder', purchaseOrder)
    expect(read.moves[0].requirements[0]).toMatchObject({ reason: 'EXPIRED', fileId: certificate.id })
    await expect(check()).rejects.toThrow(/the one on file expired on/)
    // A valid date meets it; the declaration still warns.
    await ok('buyer', 'PUT', `/files/${certificate.id}/document`, { expiresOn: addDays(today(), 20), version: await versionOf(certificate.id) })
    read = await documents('PurchaseOrder', purchaseOrder)
    expect(read.moves[0].requirements.map((r: Json) => r.reason)).toEqual(['MET', 'MISSING'])
    expect(read.documents).toEqual([expect.objectContaining({ fileId: certificate.id, ofParty: true, expiryState: 'EXPIRING', daysLeft: 20 })])
    const { result } = await check()
    expect(result.sentences).toEqual(['A declaration is needed before Confirmed: none is on file.'])
    // REFUSED: a date that is not one; a stale version; tagging without files.upload.
    expect((await tag('buyer', certificate.id, { expiresOn: '2026-02-30', version: await versionOf(certificate.id) })).status).toBe(400)
    expect((await tag('buyer', certificate.id, { category: 'TEST_REPORT', version: 1 })).status).toBe(409)
    expect((await tag('reader', certificate.id, { category: 'TEST_REPORT', version: await versionOf(certificate.id) })).status).toBe(403)
  })
})

describe('document expiry (COL-049)', () => {
  it('reminds 30 then 7 days before, once each: the owner is told, the partner asked for a new version; a later date answers it', async () => {
    const [certificate] = await admin<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "recordType" = 'Party' AND "recordId" = $1`, [supplier])
    mark = new Date(0)
    let pass = await remind()
    expect(pass).toMatchObject({ reminded: 1, failed: 0 })
    expect((await remind()).reminded).toBe(0)
    const tasks = () => admin(`SELECT kind, status, "sourceKey", "recordType", "partyId" FROM "PartnerTask" WHERE "tenantId" = $1`, [tenant.id])
    expect(await tasks()).toEqual([{ kind: 'UPLOAD_DOCUMENT', status: 'OPEN', sourceKey: `Expiry:${certificate!.id}:${addDays(today(), 20)}`, recordType: 'Party', partyId: supplier }])
    // The record's owner (who added the document) is told, through the fan-out.
    expect(await fanOutSince(['file.expiry_due'])).toBe(1)
    const [told] = await admin(`SELECT "userId", "messageKey", params FROM "Notification" WHERE "tenantId" = $1 AND "messageKey" = 'notifications.files.expiryDue'`, [tenant.id])
    expect(told).toMatchObject({ userId: PEOPLE.admin, params: expect.objectContaining({ kindLabel: 'LWG certificate.pdf', window: 30 }) })
    // Fourteen days on: the 7-day reminder; the same request.
    h.clock.advance(14 * 86_400_000)
    pass = await remind()
    expect(pass.reminded).toBe(1)
    expect((await tasks()).length).toBe(1)
    // A new date, beyond the reminders: the reminder is cleared and the request answered.
    await ok('buyer', 'PUT', `/files/${certificate!.id}/document`, { expiresOn: addDays(today(), 365), version: await versionOf(certificate!.id) })
    expect(await admin(`SELECT "expiryRemindedAt" FROM "StoredFile" WHERE id = $1`, [certificate!.id])).toEqual([{ expiryRemindedAt: null }])
    expect((await tasks())[0]).toMatchObject({ status: 'DONE' })
  })

  it("closes a request at the next pass once a new version is in force, and never reminds a superseded version", async () => {
    const declaration = await uploaded(pdf('REACH declaration v1'), { recordType: 'Party', recordId: supplier, originalName: 'REACH declaration.pdf', visibility: ['OFFICE', 'PARTNER'], partyId: supplier }, 'admin')
    await ok('buyer', 'PUT', `/files/${declaration.id}/document`, { category: 'DECLARATION', expiresOn: addDays(today(), 10), version: await versionOf(declaration.id) })
    expect((await remind()).reminded).toBe(1)
    const v2Body = pdf('REACH declaration v2')
    const { file: v2, upload } = await ok('admin', 'POST', `/files/${declaration.id}/versions`, { originalName: 'REACH declaration 2027.pdf', contentType: 'application/pdf', sizeBytes: v2Body.length, sha256: sha256(v2Body) }, 201)
    expect((await send(upload, v2Body)).statusCode).toBe(200)
    await ok('admin', 'POST', `/files/${v2.id}/complete`)
    // REFUSED: the superseded version says nothing any more.
    expect((await tag('buyer', declaration.id, { expiresOn: addDays(today(), 30), version: await versionOf(declaration.id) })).status).toBe(409)
    const pass = await remind()
    expect(pass).toMatchObject({ reminded: 0, closed: 1 })
    expect(await admin(`SELECT status FROM "PartnerTask" WHERE "sourceKey" LIKE $1`, [`Expiry:${declaration.id}:%`])).toEqual([{ status: 'DONE' }])
  })
})

describe('markup and the Versions pop-up (COL-055, COL-046)', () => {
  it('a PDF page gets an overlay; the PDF never changes', async () => {
    const pattern = await uploaded(pdf('JK-210 pattern'), { recordType: 'PurchaseOrder', recordId: purchaseOrder, originalName: 'JK-210-pattern.pdf' })
    const arrow = { kind: 'arrow', from: { x: 0.1, y: 0.1 }, to: { x: 0.4, y: 0.5 } }
    const made = await ok('buyer', 'POST', `/files/${pattern.id}/markups`, { page: 2, shapes: [arrow], note: 'Move the stitch line 3 mm', result: null }, 201)
    expect(made).toMatchObject({ file: null, upload: null, markup: { page: 2, note: 'Move the stitch line 3 mm', resultFileId: null, createdByName: 'buyer 177' } })
    // REFUSED: no page on a PDF; a marked copy of a PDF; nothing drawn; without files.upload.
    expect((await call('buyer', 'POST', `/files/${pattern.id}/markups`, { page: null, shapes: [arrow], note: null, result: null })).body.error.issues.map((i: Json) => i.path)).toEqual(['body/page'])
    expect((await call('buyer', 'POST', `/files/${pattern.id}/markups`, { page: 1, shapes: [], note: null, result: { contentType: 'image/png', sizeBytes: 9, sha256: 'a'.repeat(64) } })).status).toBe(400)
    expect((await call('reader', 'POST', `/files/${pattern.id}/markups`, { page: 1, shapes: [arrow], note: null, result: null })).status).toBe(403)
    expect((await ok('buyer', 'GET', `/files/${pattern.id}/markups`)).markups).toHaveLength(1)
    // A copy on another record: "which records use it".
    const caller = callerFor(h.database, systemContext(tenant.id, newId()))
    const copy = await prepareFileCopy(processFiles(), caller, pattern.id, { companyId: company, recordType: 'Shipment', recordId: newId() })
    await command(caller, { name: 'files.storeGenerated', input: { copy: pattern.id } }, (tools) => recordGeneratedFile(tools, copy))
    const [only] = (await ok('reader', 'GET', `/files/${pattern.id}/history`)).versions
    expect(only).toMatchObject({ versionNo: 1, current: true, markups: 1, madeByMarkup: null, addedBy: { id: PEOPLE.buyer, name: 'buyer 177', fromPartner: false } })
    expect(only.usedBy).toEqual([expect.objectContaining({ recordType: 'Shipment', label: null })])
  })

  it('a marked picture becomes the next version once sent; the picture it was drawn on stays, read-only', async () => {
    const photo = png(1)
    const { file: v1, upload } = await ok('buyer', 'POST', '/files', { companyId: company, recordType: 'PurchaseOrder', recordId: purchaseOrder, kind: 'PHOTO', originalName: 'sample front.png', contentType: 'image/png', sizeBytes: photo.length, sha256: sha256(photo) }, 201)
    expect((await send(upload, photo)).statusCode).toBe(200)
    await ok('buyer', 'POST', `/files/${v1.id}/complete`)
    const marked = png(2)
    const circle = { kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.1 }
    // REFUSED: a picture's markup with no marked copy announced; a GIF as the copy.
    expect((await call('buyer', 'POST', `/files/${v1.id}/markups`, { page: null, shapes: [circle], note: null, result: null })).body.error.issues.map((i: Json) => i.path)).toEqual(['body/result'])
    expect((await call('buyer', 'POST', `/files/${v1.id}/markups`, { page: null, shapes: [circle], note: null, result: { contentType: 'image/gif', sizeBytes: 9, sha256: sha256(marked) } })).status).toBe(400)
    const made = await ok('buyer', 'POST', `/files/${v1.id}/markups`, { page: null, shapes: [circle], note: 'Loose thread here', result: { contentType: 'image/png', sizeBytes: marked.length, sha256: sha256(marked) } }, 201)
    expect(made.file).toMatchObject({ status: 'PENDING_UPLOAD', versionNo: 2, seriesId: v1.id, originalName: 'sample front (marked).png' })
    expect(made.markup).toMatchObject({ fileId: v1.id, resultFileId: made.file.id, page: null })
    // REFUSED: a second markup while the marked copy is still being sent (one new version at a time).
    expect((await call('buyer', 'POST', `/files/${v1.id}/markups`, { page: null, shapes: [circle], note: null, result: { contentType: 'image/png', sizeBytes: marked.length, sha256: sha256(marked) } })).status).toBe(409)
    expect((await send(made.upload, marked)).statusCode).toBe(200)
    await ok('buyer', 'POST', `/files/${made.file.id}/complete`)
    const versions = (await ok('buyer', 'GET', `/files/${v1.id}/history`)).versions
    expect(versions.map((v: Json) => [v.versionNo, v.current, v.markups, v.madeByMarkup?.marks ?? null])).toEqual([
      [1, false, 1, null],
      [2, true, 0, 1],
    ])
    expect(versions[1].madeByMarkup.note).toBe('Loose thread here')
    // REFUSED: marking up the superseded original.
    const again = await call('buyer', 'POST', `/files/${v1.id}/markups`, { page: null, shapes: [circle], note: null, result: { contentType: 'image/png', sizeBytes: marked.length, sha256: sha256(marked) } })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe('Only the current version is marked up: open the newest version and mark it up there.')
    // A spreadsheet has nothing to mark.
    const sheet = await uploaded(Buffer.from('a,b\n1,2\n'), { recordType: 'PurchaseOrder', recordId: purchaseOrder, kind: 'ATTACHMENT', originalName: 'sizes.csv', contentType: 'text/csv' })
    expect((await call('buyer', 'POST', `/files/${sheet.id}/markups`, { page: null, shapes: [circle], note: null, result: null })).body.error.issues[0].path).toBe('params/fileId')
  })
})
