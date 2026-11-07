import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, startHarness, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { fileTravelDocuments, madeUpPdf, TRAVEL_DOCUMENT_PERMISSIONS } from '../../shipping/documents/testing/compliance'

/**
 * Customer documents in the portal on the local stack (B-W2b-178; SAL-086, SAL-087, SAL-092, QHS-111), through the real
 * app and the real portal sign-in by code. Tenant A from the factory-db seeds up to money (SEED-SO-0002's SH-0001 SHIPPED
 * with SEED-JKT-02 BLK 50 and RED 52 of WO-0001, its PASSED inspection; FT-2026-00001 and the deposit invoice FT-2026-00003
 * of the customer SEED-C1, XML only). The office (a test session on a second app over the same database) makes the
 * documents the way its own screens do: the style's DoC and leaflet put on file and copied onto the shipment (B-W1-49), the
 * inspection report and the certificate of conformity kept and shared (B-W2b-123), a file shared on the order and replaced
 * by a second version (B-W2b-160); the accepted quote's PDF is written as the quote send stores it. The customer's buyer,
 * finance, quality and designer people and another customer's buyer read them. Every name, number and price is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-documents`.
 */

let h: Harness
let app: FastifyInstance
let shipping: ShippingSeed
let world: PortalWorld
const NS = 'portal-documents-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
let counter = 0
const key = () => `pdocs-${++counter}-${newId()}`

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const QUALITY: Permission[] = [...TRAVEL_DOCUMENT_PERMISSIONS, 'quality.inspections.view', 'shipping.view', 'shipping.manage', 'quality.documents.make', 'quality.documents.share', 'files.manage']
let qualityActor = ''
const SESSIONS: Record<string, () => SessionContext> = { quality: () => ({ audience: 'office', tenantId: T, actorId: qualityActor, grants: [grant(QUALITY)] }) }

async function office(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 201): Promise<Json> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': 'quality', ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}

const people = {
  buyer: 'bianca.buyer@seed-racing.example',
  finance: 'franca.finance@seed-racing.example',
  quality: 'quinto.quality@seed-racing.example',
  designer: 'dora.designer@seed-racing.example',
  other: 'otto.buyer@brand-alpha.example',
}
const browsers = {} as Record<keyof typeof people, Browser>
const personId = {} as Record<keyof typeof people, string>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
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

async function ok(browser: Browser, url: string): Promise<Json> {
  const answer = await browser.get(url)
  expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(200)
  return answer.body as Json
}

const MONEY = /cost|margin|price|amount|total|wage/i
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
const kinds = (list: Json) => (list.items as Json[]).map((item) => item.kind).sort()
const byKind = (list: Json, kind: string): Json => (list.items as Json[]).find((item) => item.kind === kind) ?? {}

/** The accepted quote version's PDF, stored as the quote's send stores it (FISCAL_ARCHIVE, shared with the customer). */
async function quotePdf(): Promise<string> {
  const version = await one<{ quoteId: string; documentSha256: string }>(`SELECT "quoteId", "documentSha256" FROM "QuoteVersion" WHERE "tenantId" = $1 AND status = 'ACCEPTED' AND "documentSha256" IS NOT NULL LIMIT 1`, [T])
  const store = await one<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY code LIMIT 1`, [T])
  const id = newId()
  const at = new Date()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: qualityActor }, (client) =>
    client.$transaction(async (tx) => {
      await tx.storedFile.create({
        data: {
          id,
          companyId: companyA,
          recordType: 'Quote',
          recordId: version.quoteId,
          kind: 'FISCAL_ARCHIVE',
          originalName: 'quote.pdf',
          contentType: 'application/pdf',
          sizeBytes: 1024,
          sha256: version.documentSha256,
          storeAccountId: store.id,
          storageKey: `legal/t/${T}/c/${companyA}/2026/${newId()}`,
          status: 'AVAILABLE',
          availableAt: at,
          visibility: ['OFFICE', 'PARTNER', 'LINK'],
          partyId: P1,
          retainUntil: new Date(at.getTime() + 11 * 365 * 86_400_000),
        },
        select: { id: true },
      })
      await tx.auditLog.create({ data: { id: newId(), audience: 'OFFICE', actorId: qualityActor, action: 'quotes.send', recordType: 'StoredFile', recordId: id, after: { documentType: 'QUOTE' }, requestId: newId(), companyId: companyA }, select: { id: true } })
    }),
  )
  return id
}

/** A file shared with the customer on its order, then its second version (the office's files panel, B-W2b-160). */
async function orderFileWithTwoVersions(orderId: string): Promise<{ first: string; second: string }> {
  const upload = async (url: string, body: Buffer, extra: Json) => {
    const announced = await office('POST', url, { originalName: 'care-and-fit-notes.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...extra }, 201)
    const upload = announced.upload
    expect((await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
    await office('POST', `/files/${announced.file.id}/complete`, undefined, 200)
    return announced.file.id as string
  }
  const first = await upload('/files', madeUpPdf('care and fit notes v1'), { recordType: 'SalesOrder', recordId: orderId, kind: 'DOCUMENT', companyId: companyA, visibility: ['OFFICE', 'PARTNER'], partyId: P1 })
  const second = await upload(`/files/${first}/versions`, madeUpPdf('care and fit notes v2'), {})
  return { first, second }
}

let docs: { quote: string; orderFile: { first: string; second: string }; reportV1: string } = { quote: '', orderFile: { first: '', second: '' }, reportV1: '' }

beforeAll(async () => {
  h = await startHarness('portal_customer_docs')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  shipping = await seedShipping({ db: h.database, namespace: NS })
  await seedMoney({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  // The letterhead a document needs (made up); the seeded accounts' bursts are production settings.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T])
  qualityActor = (await addUser(h, TENANT, { email: 'quality.documents@example.com' })).id
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, TENANT)
  freshGuard(h)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )

  // The office's documents, as its screens make them.
  const production = shipping.quality.production
  await fileTravelDocuments(app, 'quality', production.styleId, production.revisionId)
  await office('POST', `/shipping/shipments/${shipping.shipmentId}/documents/attach`, {}, 200)
  await office('POST', `/quality/inspections/${shipping.quality.passedInspectionId}/reports`, { language: 'en' })
  await office('POST', `/quality/inspections/${shipping.quality.passedInspectionId}/reports/share`, { shipmentId: shipping.shipmentId })
  docs.reportV1 = (await one<{ id: string }>(`SELECT id FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND "originalName" LIKE '%inspection report%'`, [shipping.shipmentId])).id
  await office('POST', `/quality/shipments/${shipping.shipmentId}/certificates`, {})
  await office('POST', `/quality/shipments/${shipping.shipmentId}/certificates/share`, {})
  docs.orderFile = await orderFileWithTwoVersions(production.salesOrderId)
  docs.quote = await quotePdf()

  personId.buyer = await partnerPerson(people.buyer, P1, ['customer-buyer'])
  personId.finance = await partnerPerson(people.finance, P1, ['customer-finance'])
  personId.quality = await partnerPerson(people.quality, P1, ['customer-quality'])
  personId.designer = await partnerPerson(people.designer, P1, ['customer-designer'])
  personId.other = await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const name of Object.keys(people) as (keyof typeof people)[]) browsers[name] = await signedIn(people[name])
}, 1_500_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await app?.close()
  await h?.close()
}, 60_000)

describe('the library per account by role (SAL-086)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('shows the buyer the delivery, conformity and order documents, newest first, each in its fixed version; no invoice', async () => {
    const list = await ok(browsers.buyer, '/portal/customer-documents')
    expect(list.chips.map((chip: Json) => chip.chip)).toEqual(['ALL', 'DELIVERY', 'CONFORMITY', 'ORDERS', 'OTHER'])
    // The files seed shares a made-up test report of the company with the customer: a certificate kind of file.
    expect(kinds(list)).toEqual(['CERTIFICATE', 'CERTIFICATE_OF_CONFORMITY', 'DECLARATION_OF_CONFORMITY', 'INSPECTION_REPORT', 'ORDER_CONFIRMATION', 'OTHER', 'USER_INFORMATION'])
    expect(byKind(list, 'CERTIFICATE')).toMatchObject({ group: 'CONFORMITY', for: { type: 'Company', label: null } })
    const doc = byKind(list, 'DECLARATION_OF_CONFORMITY')
    expect(doc).toMatchObject({ group: 'CONFORMITY', version: 1, language: 'it', current: true, replacedBy: null, new: true, for: { type: 'Shipment', label: 'SEED-SH-0001', order: { number: 'SEED-SO-0002' } } })
    expect(doc.title.en).toMatch(/^EU declaration of conformity · .*SEED-JKT-02 · rev 1$/)
    expect(doc.fingerprint).toBe(doc.sha256.slice(0, 12))
    expect(byKind(list, 'INSPECTION_REPORT')).toMatchObject({ version: 1, language: 'en' })
    expect(byKind(list, 'ORDER_CONFIRMATION')).toMatchObject({ group: 'ORDERS', for: { type: 'Quote' } })
    // The order's file: only its second version is current; the first names it.
    expect(byKind(list, 'OTHER')).toMatchObject({ id: docs.orderFile.second, version: 2, current: true })
    const all = await ok(browsers.buyer, '/portal/customer-documents?versions=all&group=OTHER')
    expect(all.items.map((item: Json) => [item.version, item.current, item.replacedBy?.id ?? null])).toEqual([
      [2, true, null],
      [1, false, docs.orderFile.second],
    ])
  })

  it('gives finance the invoices with their PDF or XML and amounts; quality the conformity without prices; not the designer', async () => {
    const finance = await ok(browsers.finance, '/portal/customer-documents?group=FINANCE')
    expect(finance.chips.map((chip: Json) => chip.chip)).toEqual(['ALL', 'DELIVERY', 'FINANCE', 'ORDERS', 'OTHER'])
    expect(finance.items.map((item: Json) => [item.kind, item.for?.label ?? null])).toEqual(expect.arrayContaining([['INVOICE', 'FT-2026-00001'], ['DEPOSIT_INVOICE', expect.any(String)]]))
    const invoice: Json = finance.items.find((item: Json) => item.title.en === 'Invoice · FT-2026-00001') ?? {}
    expect(invoice).toMatchObject({ grossTotal: 61000, currency: 'EUR', files: [{ format: 'XML' }] })
    expect((await ok(browsers.finance, '/portal/customer-documents')).items.some((item: Json) => item.group === 'CONFORMITY')).toBe(false)

    const quality = await ok(browsers.quality, '/portal/customer-documents')
    expect(quality.seesPrices).toBe(false)
    expect(quality.chips.map((chip: Json) => chip.chip)).toEqual(['ALL', 'DELIVERY', 'CONFORMITY', 'OTHER'])
    expect(kinds(quality)).not.toContain('ORDER_CONFIRMATION')
    expect(keysOf(quality.items).filter((name) => MONEY.test(name))).toEqual([])
    expect((await browsers.quality.get('/portal/customer-documents?group=FINANCE')).status).toBe(400)
    expect((await browsers.designer.get('/portal/customer-documents')).status).toBe(403)
    expect((await browsers.designer.get('/portal/customer-documents/conformity')).status).toBe(403)
  })

  it('keeps another customer out, and filters by order, by search and by new', async () => {
    expect((await ok(browsers.other, '/portal/customer-documents')).count).toBe(0)
    expect((await browsers.other.get(`/portal/customer-documents/${docs.orderFile.second}`)).status).toBe(404)
    const order = shipping.quality.production.salesOrderId
    const ofOrder = await ok(browsers.buyer, `/portal/customer-documents?orderId=${order}`)
    expect(kinds(ofOrder)).toEqual(['CERTIFICATE_OF_CONFORMITY', 'DECLARATION_OF_CONFORMITY', 'INSPECTION_REPORT', 'OTHER', 'USER_INFORMATION'])
    expect((await ok(browsers.buyer, `/portal/customer-documents?q=${encodeURIComponent('leaflet nothing')}`)).count).toBe(0)
    expect(kinds(await ok(browsers.buyer, `/portal/customer-documents?q=${encodeURIComponent('conformita JKT-02')}`))).toEqual(['DECLARATION_OF_CONFORMITY'])
    expect((await ok(browsers.buyer, '/portal/customer-documents?new=true')).count).toBe(7)
  })
})

describe('downloads logged (QHS-111) and fixed versions (SAL-092)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('opens a document in place or saves it, each open recorded with who and what; then it is no longer new', async () => {
    const list = await ok(browsers.buyer, '/portal/customer-documents')
    const doc = byKind(list, 'DECLARATION_OF_CONFORMITY')
    const preview = await browsers.buyer.post(`/portal/customer-documents/${doc.id}/download`, { mode: 'preview' })
    expect(preview.status, JSON.stringify(preview.body)).toBe(200)
    expect(preview.body).toMatchObject({ document: { id: doc.id, kind: 'DECLARATION_OF_CONFORMITY', format: 'PDF' }, download: { mode: 'inline', method: 'GET' } })
    const bytes = await h.app.inject({ method: 'GET', url: (preview.body as Json).download.url })
    expect(bytes.statusCode).toBe(200)
    expect(bytes.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await browsers.buyer.post(`/portal/customer-documents/${doc.id}/download`, {})).body).toMatchObject({ download: { mode: 'download' } })
    const logged = await admin<{ audience: string; actorId: string; partyId: string; after: Json }>(
      `SELECT audience::text AS audience, "actorId", "partyId", after FROM "AuditLog" WHERE action = 'customerDocuments.download' AND "recordId" = $1 ORDER BY at`,
      [doc.id],
    )
    expect(logged.map((row) => [row.audience, row.actorId, row.partyId, row.after.mode, row.after.kind])).toEqual([
      ['PARTNER', personId.buyer, P1, 'preview', 'DECLARATION_OF_CONFORMITY'],
      ['PARTNER', personId.buyer, P1, 'download', 'DECLARATION_OF_CONFORMITY'],
    ])
    expect(byKind(await ok(browsers.buyer, '/portal/customer-documents'), 'DECLARATION_OF_CONFORMITY').new).toBe(false)
    // Still new for a colleague who has not opened it.
    expect(byKind(await ok(browsers.quality, '/portal/customer-documents'), 'DECLARATION_OF_CONFORMITY').new).toBe(true)
  })

  it("serves finance an invoice's office-only XML; refuses it to a role without invoices", async () => {
    const invoice: Json = (await ok(browsers.finance, '/portal/customer-documents?group=FINANCE')).items.find((item: Json) => item.title.en === 'Invoice · FT-2026-00001') ?? {}
    const xml = invoice.files[0].fileId
    const opened = await browsers.finance.post(`/portal/customer-documents/${xml}/download`, {})
    expect(opened.status, JSON.stringify(opened.body)).toBe(200)
    expect(opened.body).toMatchObject({ document: { kind: 'INVOICE', format: 'XML' }, download: { mode: 'download' } })
    expect((await browsers.quality.post(`/portal/customer-documents/${xml}/download`, {})).status).toBe(404)
    expect((await browsers.buyer.post(`/portal/customer-documents/${xml}/download`, {})).status).toBe(404)
    expect((await browsers.designer.post(`/portal/customer-documents/${xml}/download`, {})).status).toBe(403)
  })

  it('names the version that replaced an earlier one; a withdrawn copy leaves the library and names the newer one', async () => {
    const earlier = await ok(browsers.buyer, `/portal/customer-documents/${docs.orderFile.first}`)
    expect(earlier.document).toMatchObject({ version: 1, current: false, replacedBy: { id: docs.orderFile.second, version: 2 } })
    expect(earlier.versions.map((version: Json) => version.version)).toEqual([2, 1])

    // A signed correction makes the inspection report's version 2; sharing it withdraws version 1's copy (B-W2b-123).
    const passed = shipping.quality.passedInspectionId
    const [defect] = await admin<{ id: string; siteId: string }>('SELECT id, "siteId" FROM "InspectionDefect" WHERE "inspectionId" = $1 LIMIT 1', [passed])
    const request = newId()
    await admin(
      `INSERT INTO "InspectionAmendment" (id, "tenantId", "siteId", "inspectionId", kind, field, "recordType", "recordId", before, after, reason, "signedById", "signedAt", "signatureSha256") VALUES ($1, $2, $3, $4, 'REQUEST', 'zone', 'InspectionDefect', $5, 'null'::jsonb, '"ELBOW_L"'::jsonb, 'Pinned at the wrong place.', $6, now(), $7)`,
      [request, T, defect!.siteId, passed, defect!.id, newId(), 'a'.repeat(64)],
    )
    await admin(`INSERT INTO "InspectionAmendment" (id, "tenantId", "siteId", "inspectionId", kind, "requestId", "signedById", "signedAt", "signatureSha256") VALUES ($1, $2, $3, $4, 'SIGNED', $5, $6, now(), $7)`, [newId(), T, defect!.siteId, passed, request, newId(), 'b'.repeat(64)])
    await office('POST', `/quality/inspections/${passed}/reports`, { language: 'en' })
    await office('POST', `/quality/inspections/${passed}/reports/share`, { shipmentId: shipping.shipmentId })

    const list = await ok(browsers.buyer, '/portal/customer-documents?group=CONFORMITY&versions=all')
    const reports = (list.items as Json[]).filter((item) => item.kind === 'INSPECTION_REPORT')
    expect(reports.map((item) => item.version)).toEqual([2])
    const gone = await ok(browsers.buyer, `/portal/customer-documents/${docs.reportV1}`)
    expect(gone).toMatchObject({ document: null, withdrawn: { version: 1, replacedBy: { id: reports[0]!.id, version: 2 } } })
    const refused = await browsers.buyer.post(`/portal/customer-documents/${docs.reportV1}/download`, {})
    expect(refused.status).toBe(409)
    expect((refused.body as Json).error.issues[0]).toMatchObject({ path: 'document/WITHDRAWN', message: expect.stringMatching(/withdrawn: open Inspection report.* \(version 2\) instead/) })
    // Another customer learns nothing of it.
    expect((await browsers.other.get(`/portal/customer-documents/${docs.reportV1}`)).status).toBe(404)
  })
})

describe('conformity per style received (SAL-087) and Home', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('names, per shipment of a style, the declaration and leaflet that travelled and the certificate valid on the shipping date', async () => {
    const answer = await ok(browsers.quality, '/portal/customer-documents/conformity')
    const style: Json = (answer.styles as Json[]).find((entry) => entry.style.code === 'SEED-JKT-02') ?? {}
    expect(style).toMatchObject({ ppe: true, certificateRequired: true })
    const row = style.received[0]
    expect(row).toMatchObject({
      shipment: { number: 'SEED-SH-0001' },
      order: { number: 'SEED-SO-0002' },
      revision: 1,
      state: 'COMPLETE',
      declaration: { kind: 'DECLARATION_OF_CONFORMITY', version: 1, language: 'it' },
      userInformation: { kind: 'USER_INFORMATION' },
      certificate: { number: 'SEED-CERT-0003', validOnShippingDate: true },
    })
    expect(row.reports.map((report: Json) => report.kind).sort()).toEqual(['CERTIFICATE_OF_CONFORMITY', 'INSPECTION_REPORT'])
    expect((await ok(browsers.quality, '/portal/customer-documents/conformity?q=nothing-like-this')).count).toBe(0)
    expect((await browsers.finance.get('/portal/customer-documents/conformity')).status).toBe(403)
  })

  it('a withdrawn declaration leaves the library; the style says a document is missing', async () => {
    const doc = byKind(await ok(browsers.quality, '/portal/customer-documents?group=CONFORMITY'), 'DECLARATION_OF_CONFORMITY')
    await admin(`UPDATE "ComplianceDocument" SET status = 'WITHDRAWN', version = version + 1 WHERE "tenantId" = $1 AND kind = 'DECLARATION_OF_CONFORMITY' AND status = 'ISSUED'`, [T])
    expect(kinds(await ok(browsers.quality, '/portal/customer-documents?group=CONFORMITY'))).not.toContain('DECLARATION_OF_CONFORMITY')
    expect(await ok(browsers.quality, `/portal/customer-documents/${doc.id}`)).toMatchObject({ document: null, withdrawn: { version: 1, replacedBy: null } })
    const row = ((await ok(browsers.quality, '/portal/customer-documents/conformity')).styles as Json[]).find((entry) => entry.style.code === 'SEED-JKT-02')?.received[0]
    expect(row).toMatchObject({ state: 'INCOMPLETE', declaration: null })
  })

  it("counts the customer's new documents on Home, for the kinds the person sees; nothing for the designer", async () => {
    const counts = async (browser: Browser) => Object.fromEntries(((await ok(browser, '/portal/home')).counts as Json[]).map((count) => [count.key, count.value]))
    const buyer = await counts(browsers.buyer)
    expect(buyer['documents.new']).toBe((await ok(browsers.buyer, '/portal/customer-documents?new=true')).count)
    expect(buyer['documents.new']).toBeGreaterThan(0)
    expect((await counts(browsers.designer))['documents.new']).toBeNull()
  })
})
