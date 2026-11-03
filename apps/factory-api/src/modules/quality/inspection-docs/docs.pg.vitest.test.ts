import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { LINK_HEADER } from '../../../platform/links/authenticator'
import { addUser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * The quality documents for a customer (B-W2b-123; QHS-055 inspection report PDF and share link, QHS-059 certificate of
 * conformity per shipment) on the local stack: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security, the generated documents' and files' guard triggers are real), the real app, the files seed's FAKE R2
 * account behind the harness's local file store, email out on the harness's FAKE SES (the only place a link's token is
 * read) and the real link authenticator (the harness's app) for the customer's side. Tenant A from the factory-db seeds up
 * to shipping (WO-0001's PASSED inspection with its releases; SH-0001 SHIPPED with its BLK 50 and RED 52; SH-0002 a DRAFT
 * of WO-0003) and email. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/quality/inspection-docs`.
 */

let h: Harness
let app: FastifyInstance
let shipping: ShippingSeed

const NS = 'w2b123-docs-a'
const idIn = (key: string) => seedUuid(NS, key)
const T = idIn('tenant')
const companyA = idIn('company:A')
const companyB = idIn('company:B')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'A' }, { id: companyB, code: 'B' }] }

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const key = () => `docs-${++counter}-${newId()}`

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (permissions: Permission[], companies: Grant['companies'] = 'all', actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: T, actorId, grants: [grant(permissions, companies)] })
const READ: Permission[] = ['quality.inspections.view', 'shipping.view', 'files.read']
const QUALITY: Permission[] = [...READ, 'quality.documents.make', 'quality.documents.share']
let qualityActor = ''
const SESSIONS: Record<string, () => SessionContext> = {
  viewer: () => office(READ),
  quality: () => office(QUALITY, 'all', qualityActor),
  shipper: () => office([...QUALITY, 'shipping.manage'], 'all', qualityActor),
  companyB: () => office(QUALITY, [companyB]),
}

async function call(session: string, method: Method, url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, type: String(response.headers['content-type'] ?? ''), raw: response.rawPayload, body: String(response.headers['content-type'] ?? '').startsWith('application/json') ? (response.json() as Json) : ({} as Json) }
}
async function ok(session: string, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}
const events = async (type: string, subject: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id`, [type, subject])).map((row) => row.payload)
const MONEY = /cost|price|margin|amount|wage|valuation/i
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
const shipmentCopies = (shipmentId: string) =>
  admin<{ id: string; sha256: string; visibility: string[]; partyId: string | null; originalName: string }>(`SELECT id, sha256, visibility::text[] AS visibility, "partyId", "originalName" FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND "originalName" LIKE '%inspection report%' ORDER BY "createdAt", id`, [shipmentId])

beforeAll(async () => {
  h = await startHarness('quality_docs')
  await seedCore({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  shipping = await seedShipping({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  // The letterhead a document needs (c.c. art. 2250), made up; the seeded accounts' bursts are production settings.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T])
  // The office person who keeps and shares (a real user: the certificate names who issued it, the link mail who sent it).
  qualityActor = (await addUser(h, TENANT, { email: 'quality.docs@example.com' })).id
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 1_500_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

const passed = () => shipping.quality.passedInspectionId
let v1: Json

describe('the inspection report (QHS-055)', () => {
  it('previews a signed inspection as a PDF; an open one is refused in words', async () => {
    const preview = await call('viewer', 'GET', `/quality/inspections/${passed()}/report?language=en`)
    expect(preview.status).toBe(200)
    expect(preview.type).toMatch(/^application\/pdf/)
    expect(preview.raw.subarray(0, 5).toString()).toBe('%PDF-')
    expect((await refused('viewer', 'GET', `/quality/inspections/${shipping.quality.openInspectionId}/report`, undefined, 409)).message).toMatch(/OPEN: a report is made of a signed result/)
    expect((await call('companyB', 'GET', `/quality/inspections/${passed()}/report`)).status).toBe(404)
  })

  it('keeps a version: a GeneratedDocument of the inspection with its PDF, the office\'s; the same contents give it back', async () => {
    expect((await refused('viewer', 'POST', `/quality/inspections/${passed()}/reports`, { language: 'en' }, 403)).code).toBe('forbidden')
    const made = await ok('quality', 'POST', `/quality/inspections/${passed()}/reports`, { language: 'en' }, 201)
    v1 = made.report
    expect(made).toMatchObject({ made: true, report: { version: 1, language: 'en' } })
    const [document] = await admin('SELECT kind::text AS kind, "recordType", "siteId", fingerprint FROM "GeneratedDocument" WHERE id = $1', [v1.id])
    expect(document).toMatchObject({ kind: 'INSPECTION_REPORT', recordType: 'Inspection' })
    const [file] = await admin<{ recordType: string; visibility: string[]; partyId: string | null; contentType: string }>('SELECT "recordType", visibility::text[] AS visibility, "partyId", "contentType" FROM "StoredFile" WHERE id = $1', [v1.fileId])
    expect(file).toEqual({ recordType: 'Inspection', visibility: ['OFFICE'], partyId: null, contentType: 'application/pdf' })
    expect(await events('inspection_report.made', passed())).toEqual([expect.objectContaining({ documentId: v1.id, version: 1, language: 'en' })])
    const again = await ok('quality', 'POST', `/quality/inspections/${passed()}/reports`, { language: 'en' }, 201)
    expect(again).toMatchObject({ made: false, report: { id: v1.id, version: 1 } })
    expect(keysOf(made).filter((name) => MONEY.test(name))).toEqual([])
  })

  it('a signed correction makes the next version; the list says where the goods went', async () => {
    const [defect] = await admin<{ id: string; siteId: string }>('SELECT id, "siteId" FROM "InspectionDefect" WHERE "inspectionId" = $1 LIMIT 1', [passed()])
    const asker = newId()
    const signer = newId()
    const request = newId()
    await admin(
      `INSERT INTO "InspectionAmendment" (id, "tenantId", "siteId", "inspectionId", kind, field, "recordType", "recordId", before, after, reason, "signedById", "signedAt", "signatureSha256") VALUES ($1, $2, $3, $4, 'REQUEST', 'zone', 'InspectionDefect', $5, 'null'::jsonb, '"ELBOW_L"'::jsonb, 'Pinned at the wrong place.', $6, now(), $7)`,
      [request, T, defect!.siteId, passed(), defect!.id, asker, 'a'.repeat(64)],
    )
    await admin(`INSERT INTO "InspectionAmendment" (id, "tenantId", "siteId", "inspectionId", kind, "requestId", "signedById", "signedAt", "signatureSha256") VALUES ($1, $2, $3, $4, 'SIGNED', $5, $6, now(), $7)`, [newId(), T, defect!.siteId, passed(), request, signer, 'b'.repeat(64)])
    const made = await ok('quality', 'POST', `/quality/inspections/${passed()}/reports`, { language: 'en' }, 201)
    expect(made).toMatchObject({ made: true, report: { version: 2 } })
    const list = await ok('viewer', 'GET', `/quality/inspections/${passed()}/reports`)
    expect(list.versions.map((version: Json) => version.version)).toEqual([2, 1])
    expect(list.shipments.map((shipment: Json) => shipment.id)).toContain(shipping.shipmentId)
    expect(list.shipments.find((shipment: Json) => shipment.id === shipping.shipmentId)).toMatchObject({ status: 'SHIPPED', shareable: true })
    expect(list.ready).toEqual({ ok: true, held: [] })
    expect(list.may).toEqual({ make: false, share: false })
  })

  it('shares through the shipment\'s documents link only: a copy for its party; a newer version withdraws the older copy', async () => {
    expect((await refused('quality', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.draftShipmentId }, 409)).issues[0].path).toBe('held/NOT_ON_SHIPMENT')
    expect((await refused('quality', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.shipmentId, version: 9 }, 409)).issues[0].path).toBe('held/NO_SUCH_VERSION')
    // Mailing the link is the shipment's own step: shipping.manage, checked before anything is copied.
    expect((await refused('quality', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.shipmentId, send: {} }, 403)).code).toBe('forbidden')
    expect(await shipmentCopies(shipping.shipmentId)).toEqual([])

    const first = await ok('quality', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.shipmentId, version: 1 }, 201)
    expect(first.shared).toMatchObject({ shipmentId: shipping.shipmentId, version: 1, copied: true, withdrawn: 0 })
    expect(first.link).toBeNull()
    const party = (await admin<{ partyId: string }>('SELECT "partyId" FROM "Shipment" WHERE id = $1', [shipping.shipmentId]))[0]!.partyId
    let copies = await shipmentCopies(shipping.shipmentId)
    expect(copies).toHaveLength(1)
    expect(copies[0]).toMatchObject({ visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: party })

    const second = await ok('quality', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.shipmentId }, 201)
    expect(second.shared).toMatchObject({ version: 2, copied: true, withdrawn: 1 })
    copies = await shipmentCopies(shipping.shipmentId)
    expect(copies.map((copy) => copy.visibility)).toEqual([['OFFICE'], ['OFFICE', 'PARTNER', 'LINK']])
    expect(copies[0]!.partyId).toBeNull()
    const again = await ok('quality', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.shipmentId }, 201)
    expect(again.shared).toMatchObject({ version: 2, copied: false, withdrawn: 0, fileId: copies[1]!.id })
    expect((await events('inspection_report.shared', passed())).map((event) => [event.version, event.withdrawn])).toEqual([[1, 0], [2, 1]])
    const list = await ok('viewer', 'GET', `/quality/inspections/${passed()}/reports`)
    expect(list.shares.map((share: Json) => [share.version, share.live])).toEqual([[1, false], [2, true]])
  })

  it('the customer opens it with the goods on the existing link; the mail carries the link, the answer never the token', async () => {
    const mails = h.ses.mails.length
    const sent = await ok('shipper', 'POST', `/quality/inspections/${passed()}/reports/share`, { shipmentId: shipping.shipmentId, send: {} }, 201)
    expect(sent.shared.copied).toBe(false)
    expect(sent.link.links.length).toBeGreaterThan(0)
    expect(JSON.stringify(sent)).not.toContain('#token=')
    const mail = h.ses.mails.slice(mails).at(-1)!
    const token = decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))![1]!)
    const listed = await h.app.inject({ method: 'GET', url: '/shipping/link/documents', headers: { [LINK_HEADER]: token } })
    expect(listed.statusCode, listed.body).toBe(200)
    const titles = (listed.json().documents as Json[]).map((document) => document.title)
    expect(titles.filter((title) => /inspection report/.test(title))).toEqual([expect.stringMatching(/ v2 \(en\)\.pdf$/)])
    expect(keysOf(listed.json()).filter((name) => MONEY.test(name))).toEqual([])
  })
})

describe('the certificate of conformity (QHS-059)', () => {
  it('is refused for a draft shipment, in words', async () => {
    const error = await refused('quality', 'POST', `/quality/shipments/${shipping.draftShipmentId}/certificates`, {}, 409)
    expect(error.issues[0]).toMatchObject({ path: 'held/NOT_CERTIFIABLE', message: expect.stringMatching(/draft/) })
    expect((await ok('viewer', 'GET', `/quality/shipments/${shipping.draftShipmentId}/certificates`)).ready.ok).toBe(false)
  })

  it('states the shipped goods with their inspections and releases; kept in the name of who keeps it; shared on its link', async () => {
    const preview = await call('viewer', 'GET', `/quality/shipments/${shipping.shipmentId}/certificate`)
    expect(preview.status).toBe(200)
    expect(preview.raw.subarray(0, 5).toString()).toBe('%PDF-')
    const view = await ok('viewer', 'GET', `/quality/shipments/${shipping.shipmentId}/certificates`)
    expect(view.ready).toEqual({ ok: true, held: [] })
    expect(view.lines.length).toBe(2)
    expect(view.lines.every((line: Json) => line.releases.length > 0 && line.inspections.length > 0)).toBe(true)
    const made = await ok('quality', 'POST', `/quality/shipments/${shipping.shipmentId}/certificates`, {}, 201)
    expect(made).toMatchObject({ made: true, certificate: { version: 1, createdBy: { id: qualityActor } } })
    expect((await admin('SELECT kind::text AS kind, "recordType" FROM "GeneratedDocument" WHERE id = $1', [made.certificate.id]))[0]).toEqual({ kind: 'CERTIFICATE_OF_CONFORMITY', recordType: 'Shipment' })
    expect((await ok('quality', 'POST', `/quality/shipments/${shipping.shipmentId}/certificates`, {}, 201)).made).toBe(false)
    const shared = await ok('quality', 'POST', `/quality/shipments/${shipping.shipmentId}/certificates/share`, {}, 201)
    expect(shared.shared).toMatchObject({ version: 1, copied: true })
    expect((await ok('viewer', 'GET', `/quality/shipments/${shipping.shipmentId}/certificates`)).shares).toEqual([expect.objectContaining({ version: 1, live: true })])
    expect(await events('conformity_certificate.shared', shipping.shipmentId)).toHaveLength(1)
    expect((await refused('viewer', 'POST', `/quality/shipments/${shipping.shipmentId}/certificates/share`, {}, 403)).code).toBe('forbidden')
  })
})
