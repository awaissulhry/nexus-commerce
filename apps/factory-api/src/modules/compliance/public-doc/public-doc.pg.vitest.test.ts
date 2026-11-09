import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { solveChallenge } from '@nexus/factory-domain/abuse/pow'
import { publicDocCodeOf } from '@nexus/factory-domain/compliance/public-doc/code'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedProduction, type ProductionSeed } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createAbuseGuard, useAbuseGuard } from '../../../platform/abuse/guard'
import { memoryAbuseStore } from '../../../platform/abuse/store'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { uploadComplianceDocument } from '../../shipping/documents/testing/compliance'
import { forgetPublicDocFiles, NOT_FOUND_WORDS, usePublicDocClock } from './public-doc'

/**
 * The public DoC (B-W2b-166; PRD-294, PRD-356; design links.doc) on the local stack with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, forced for the system scope the
 * lookup reads each tenant in), the factory-db seeds of TWO tenants (each with SEED-JKT-02, its released revision 1 and
 * WO-0001 released as batch SEED-BT-0001, WO-0002 a draft), the harness's local file store behind the files seed's FAKE R2
 * account, a fresh abuse guard in memory per part. The signed PDFs go on file through the style compliance tab's own
 * routes (announce, send, confirm: B-W1-20). Every name, number and PDF is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/compliance/public-doc`.
 */

let h: Harness
let app: FastifyInstance

const ns = { a: 'publicdoc-a', b: 'publicdoc-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = { tenant: idOf(ns.a, 'tenant'), companyA: idOf(ns.a, 'company:A'), companyB: idOf(ns.a, 'company:B') }
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }
let prodA: ProductionSeed
let prodB: ProductionSeed

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  quality: office(A.tenant, [grant(['compliance.certificates.view', 'compliance.declarations.manage', 'files.read', 'files.upload'])]),
  viewer: office(A.tenant, [grant(['compliance.certificates.view'])]),
  nobody: office(A.tenant, [grant(['shipping.view'])]),
  companyB: office(A.tenant, [grant(['compliance.certificates.view'], [A.companyB])]),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% made-up signed document: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

let network = 0
/** A reader on a network of its own (each part counts its own traffic), or the one given. */
const lookup = (code: string, extra: Json = {}, remoteAddress = `198.51.100.${(network % 250) + 1}`) =>
  app.inject({ method: 'POST', url: '/public/doc/lookup', payload: { code, ...extra }, remoteAddress })
async function page(code: string, extra: Json = {}): Promise<Json> {
  const response = await lookup(code, extra)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().page
}
const file = (code: string, fileId: string, query = '') => app.inject({ method: 'GET', url: `/public/doc/${code}/files/${fileId}${query}`, remoteAddress: '198.51.100.250' })
const asOffice = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })

/** The one 404 every miss gets (the same words; only the request id differs). */
function missed(response: { statusCode: number; json(): Json }): void {
  expect(response.statusCode).toBe(404)
  const { error } = response.json()
  expect({ code: error.code, message: error.message, issues: error.issues }).toEqual({ code: 'not_found', message: NOT_FOUND_WORDS, issues: undefined })
}

const BODY = {
  docIt1: pdf('SEED-JKT-02 DoC revision 1 it'),
  docEn1: pdf('SEED-JKT-02 DoC revision 1 en'),
  leafletEn1: pdf('SEED-JKT-02 leaflet revision 1 en'),
  docIt2: pdf('SEED-JKT-02 DoC revision 2 it'),
  otherTenant: pdf('tenant B SEED-JKT-02 DoC revision 1 it'),
}
const F: Record<string, string> = {}
const batchCode = () => publicDocCodeOf(prodA.workOrderId)
const styleCode = () => publicDocCodeOf(prodA.styleId)
const freshGuard = () => useAbuseGuard(createAbuseGuard({ store: memoryAbuseStore(), key: Buffer.alloc(32, 9), prefix: 'test', clock: h.clock }))

beforeAll(async () => {
  h = await startHarness('public_doc')
  h.clock.set('2026-11-20T09:00:00.000Z')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  prodA = await seedProduction({ db: h.database, namespace: ns.a })
  prodB = await seedProduction({ db: h.database, namespace: ns.b })
  for (const namespace of [ns.a, ns.b]) {
    await seedFiles({ db: h.database, namespace })
    await seedEmail({ db: h.database, namespace })
  }
  // This file announces and confirms several PDFs: more than the seeded store account's default burst.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // A made-up EU type-examination certificate covering SEED-JKT-02 in tenant A (the register's VALID row).
  const certificateId = newId()
  await admin(
    `INSERT INTO "Certificate" (id, "tenantId", "companyId", standard, "ppeClass", number, "notifiedBodyName", "notifiedBodyNumber", "validFrom", "validTo", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'EN 17092-3:2020', 'AA', 'DEMO-EU-0042', 'Organismo Notificato Demo', '0000', '2026-01-01', '2030-12-31', 'VALID', now(), now())`,
    [certificateId, A.tenant, A.companyA],
  )
  await admin(`INSERT INTO "CertificateCoverage" (id, "tenantId", "certificateId", "styleId", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, now(), now())`, [newId(), A.tenant, certificateId, prodA.styleId])
  freshGuard()
  usePublicDocClock(h.clock)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: { max: 10_000, timeWindowMs: 60_000 } },
    {
      database: h.database,
      clock: h.clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 180_000)

afterAll(async () => {
  useAbuseGuard(undefined)
  usePublicDocClock(undefined)
  forgetPublicDocFiles()
  await app?.close()
  await h?.close()
}, 60_000)

describe('a released batch before anything is published', () => {
  it('opens by its code for anyone, with no sign-in: the product, the batch, the maker, and no declaration yet', async () => {
    network++
    const shown = await page(batchCode())
    expect(shown).toMatchObject({
      kind: 'BATCH',
      path: batchCode(),
      product: { style: { code: 'SEED-JKT-02' }, batch: { number: 'SEED-BT-0001', releasedOn: '2026-11-15' } },
      ppe: { category: 'CATEGORY_II', certificateRequired: true },
      declaration: null,
      missing: 'NOT_PUBLISHED',
      instructions: { files: [] },
      versions: [],
      n: 0,
      others: [],
      sender: { companyId: A.companyA },
    })
    expect(shown.code).toBe(`${batchCode().slice(0, 4)}-${batchCode().slice(4)}`)
    // The certificate covering the style, valid on the batch's release day.
    expect(shown.certificate).toEqual({ number: 'DEMO-EU-0042', notifiedBody: { name: 'Organismo Notificato Demo', number: '0000' }, standard: 'EN 17092-3:2020', ppeClass: 'AA', validFrom: '2026-01-01', validTo: '2030-12-31', day: '2026-11-15', validOnDay: true })
    // A typed code reads the same: lower case, a hyphen, O for 0.
    const typed = `${batchCode().slice(0, 4).toLowerCase()}-${batchCode().slice(4)}`.replace(/0/g, 'O')
    expect((await page(typed)).path).toBe(batchCode())
    // Never a price, a cost or a person.
    expect(JSON.stringify(shown)).not.toMatch(/price|cost|amount|wage|actorId|createdById|releasedById/i)
  })

  it('answers every miss with the same 404: not a code, unknown, a draft work order, a style with nothing published, a tenant switched off', async () => {
    network++
    missed(await lookup('not a code'))
    missed(await lookup('ZZZZ-ZZZZ'))
    missed(await lookup(publicDocCodeOf(prodA.draftWorkOrderId)))
    missed(await lookup(styleCode()))
    // Tenant B's own batch is found (every active tenant is asked) — until the tenant is no longer active.
    expect((await page(publicDocCodeOf(prodB.workOrderId))).sender.companyId).toBe(B.companyA)
    await admin(`UPDATE "Tenant" SET status = 'SUSPENDED' WHERE id = $1`, [B.tenant])
    try {
      missed(await lookup(publicDocCodeOf(prodB.workOrderId)))
    } finally {
      await admin(`UPDATE "Tenant" SET status = 'ACTIVE' WHERE id = $1`, [B.tenant])
    }
    // A pick past the records under the code is a miss too.
    missed(await lookup(batchCode(), { n: 1 }))
  })
})

describe('the declaration of revision 1, its leaflet and the PDFs', () => {
  it('shows the batch its own revision 1 declaration in the label languages, the leaflet, and the style code opens too', async () => {
    F.docIt1 = (await uploadComplianceDocument(app, 'quality', { styleId: prodA.styleId, revisionId: prodA.revisionId, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', body: BODY.docIt1 })).fileId
    F.docEn1 = (await uploadComplianceDocument(app, 'quality', { styleId: prodA.styleId, revisionId: prodA.revisionId, kind: 'DECLARATION_OF_CONFORMITY', language: 'en', body: BODY.docEn1 })).fileId
    F.leafletEn1 = (await uploadComplianceDocument(app, 'quality', { styleId: prodA.styleId, revisionId: prodA.revisionId, kind: 'USER_INFORMATION', language: 'en', body: BODY.leafletEn1 })).fileId
    network++
    const shown = await page(batchCode())
    expect(shown.missing).toBeNull()
    expect(shown.declaration).toMatchObject({ revision: 1, standing: 'CURRENT', before: null, batches: { first: '2026-11-15', last: '2026-11-15' } })
    expect(shown.declaration.files.map((entry: Json) => [entry.language, entry.fileId, entry.sha256])).toEqual([
      ['it', F.docIt1, sha(BODY.docIt1)],
      ['en', F.docEn1, sha(BODY.docEn1)],
    ])
    expect(shown.instructions.files.map((entry: Json) => [entry.language, entry.fileId])).toEqual([['en', F.leafletEn1]])
    // SEED-JKT-02 is made for the brand P1 (private label): the brand is the legal maker, as its declaration prints it.
    expect(shown.product.maker).toEqual({ name: (await admin(`SELECT "makerName" FROM "ComplianceDocument" WHERE id = (SELECT "recordId" FROM "StoredFile" WHERE id = $1)`, [F.docIt1]))[0]!.makerName, address: expect.any(String), role: 'BRAND' })
    const style = await page(styleCode())
    expect(style).toMatchObject({ kind: 'STYLE', product: { batch: null }, declaration: { revision: 1, standing: 'CURRENT' } })
    // A style's certificate is judged on today.
    expect(style.certificate).toMatchObject({ day: '2026-11-20', validOnDay: true })
  })

  it('serves exactly the page’s PDFs, inline or as a download, and the same 404 for anything else', async () => {
    const inline = await file(batchCode(), F.docIt1!)
    expect(inline.statusCode, inline.body).toBe(200)
    expect(inline.headers['content-type']).toContain('application/pdf')
    expect(inline.headers['content-disposition']).toMatch(/^inline; filename="/)
    expect(sha(inline.rawPayload)).toBe(sha(BODY.docIt1))
    const saved = await file(batchCode().toLowerCase(), F.leafletEn1!, '?download=1')
    expect(saved.statusCode).toBe(200)
    expect(saved.headers['content-disposition']).toMatch(/^attachment; filename="/)
    expect(sha(saved.rawPayload)).toBe(sha(BODY.leafletEn1))
    // The style's code serves the same files; another tenant's file, a garbage id, an unknown code: the one 404.
    expect((await file(styleCode(), F.docEn1!)).statusCode).toBe(200)
    const other = (await uploadComplianceDocument(app, 'quality', { styleId: prodA.styleId, revisionId: prodA.revisionId, kind: 'DECLARATION_OF_CONFORMITY', language: 'de', body: pdf('de') })).fileId
    await admin(`UPDATE "ComplianceDocument" SET status = 'WITHDRAWN' WHERE id = (SELECT "recordId" FROM "StoredFile" WHERE id = $1)`, [other])
    missed(await file(batchCode(), other))
    missed(await file(batchCode(), newId()))
    missed(await file('ZZZZZZZZ', F.docIt1!))
    missed(await file(publicDocCodeOf(prodB.workOrderId), F.docIt1!))
  })

  it('reads and writes nothing else: no audit row, no event', async () => {
    const counts = async () => (await admin<{ audit: number; events: number }>(`SELECT (SELECT count(*)::int FROM "AuditLog") AS audit, (SELECT count(*)::int FROM "OutboxEvent") AS events`))[0]
    const before = await counts()
    network++
    await page(batchCode())
    await page(styleCode())
    expect((await file(batchCode(), F.docEn1!)).statusCode).toBe(200)
    expect(await counts()).toEqual(before)
  })
})

describe('a later revision released with its own declaration', () => {
  it('the old batch keeps its revision 1 declaration "for batches before" the new release; the style shows revision 2 and lists revision 1', async () => {
    const rev2 = newId()
    await admin(`UPDATE "StyleRevision" SET status = 'OBSOLETE' WHERE id = $1`, [prodA.revisionId])
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status, "labelTemplateId", "changeNote", "createdAt", "updatedAt") VALUES ($1, $2, $3, 2, 'DRAFT', $4, 'A made-up second revision.', now(), now())`, [
      rev2,
      A.tenant,
      prodA.styleId,
      prodA.labelTemplateId,
    ])
    F.docIt2 = (await uploadComplianceDocument(app, 'quality', { styleId: prodA.styleId, revisionId: rev2, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', body: BODY.docIt2 })).fileId
    network++
    // Issued for a revision not released yet: the batch's declaration is still the current one.
    expect((await page(batchCode())).declaration).toMatchObject({ revision: 1, standing: 'CURRENT' })
    await admin(`UPDATE "StyleRevision" SET status = 'RELEASED', "releasedAt" = '2026-12-01T09:00:00Z', "releasedById" = $2 WHERE id = $1`, [rev2, newId()])
    const batch = await page(batchCode())
    expect(batch.declaration).toMatchObject({ revision: 1, standing: 'EARLIER', before: '2026-12-01' })
    expect(batch.declaration.files.map((entry: Json) => entry.fileId)).toEqual([F.docIt1, F.docEn1])
    expect(batch.versions).toEqual([])
    const style = await page(styleCode())
    expect(style.declaration).toMatchObject({ revision: 2, standing: 'CURRENT', batches: null })
    expect(style.declaration.files.map((entry: Json) => entry.fileId)).toEqual([F.docIt2])
    expect(style.versions).toMatchObject([{ revision: 1, batches: { first: '2026-11-15', last: '2026-11-15' } }])
    expect(style.versions[0].declarations.map((entry: Json) => entry.fileId)).toEqual([F.docIt1, F.docEn1])
    expect(style.versions[0].instructions.map((entry: Json) => entry.fileId)).toEqual([F.leafletEn1])
    // The printed code still opens its batch's PDF; the older version's PDF opens from the style's code too.
    expect((await file(batchCode(), F.docIt1!)).statusCode).toBe(200)
    expect((await file(styleCode(), F.docIt1!)).statusCode).toBe(200)
    expect((await file(batchCode(), F.docIt2!)).statusCode).toBe(404)
  })
})

describe('rate limits and the check after suspicious traffic', () => {
  it('after ten misses from one network the lookup asks for a solved check; with it, the page opens; other networks are not held', async () => {
    freshGuard()
    const here = '203.0.113.7'
    for (let miss = 0; miss < 10; miss++) missed(await lookup(`ZZZZZZ${String(miss).padStart(2, '0')}`, {}, here))
    const held = await lookup(batchCode(), {}, here)
    expect(held.statusCode, held.body).toBe(429)
    expect(held.json().error.issues.map((issue: Json) => issue.path)).toContain('challenge')
    expect((await lookup(batchCode(), {}, '203.0.113.8')).statusCode).toBe(200)
    const challenge = await app.inject({ method: 'GET', url: '/abuse/challenge?policy=public.lookup', remoteAddress: here })
    expect(challenge.statusCode, challenge.body).toBe(200)
    const { challenge: text, bits } = challenge.json()
    const nonce = solveChallenge(text, bits)!
    const answered = await lookup(batchCode(), { proof: { challenge: text, nonce } }, here)
    expect(answered.statusCode, answered.body).toBe(200)
    // A proof is used once.
    expect((await lookup(batchCode(), { proof: { challenge: text, nonce } }, here)).statusCode).toBe(429)
    freshGuard()
  })
})

describe("the office's address of a style or a batch", () => {
  it('names the code and the address the QR holds, and whether the page shows something', async () => {
    const batch = await asOffice('viewer', `/compliance/public-doc/address?workOrderId=${prodA.workOrderId}`)
    expect(batch.statusCode, batch.body).toBe(200)
    expect(batch.json().address).toEqual({
      kind: 'BATCH',
      code: `${batchCode().slice(0, 4)}-${batchCode().slice(4)}`,
      path: `/doc/${batchCode()}`,
      address: `${h.email.webOrigin}/doc/${batchCode()}`,
      live: true,
    })
    expect((await asOffice('viewer', `/compliance/public-doc/address?workOrderId=${prodA.draftWorkOrderId}`)).json().address).toMatchObject({ kind: 'BATCH', live: false })
    expect((await asOffice('viewer', `/compliance/public-doc/address?styleId=${prodA.styleId}`)).json().address).toMatchObject({ kind: 'STYLE', path: `/doc/${styleCode()}`, live: true })
    // No permission → 403; a company the person does not reach, or another tenant's record → 404; both or neither → 400.
    expect((await asOffice('nobody', `/compliance/public-doc/address?styleId=${prodA.styleId}`)).statusCode).toBe(403)
    expect((await asOffice('companyB', `/compliance/public-doc/address?workOrderId=${prodA.workOrderId}`)).statusCode).toBe(404)
    expect((await asOffice('viewer', `/compliance/public-doc/address?workOrderId=${prodB.workOrderId}`)).statusCode).toBe(404)
    expect((await asOffice('viewer', `/compliance/public-doc/address?workOrderId=${prodA.workOrderId}&styleId=${prodA.styleId}`)).statusCode).toBe(400)
    expect((await asOffice('viewer', '/compliance/public-doc/address')).statusCode).toBe(400)
    // No session: 401 (the office route is not public).
    expect((await app.inject({ method: 'GET', url: `/compliance/public-doc/address?styleId=${prodA.styleId}` })).statusCode).toBe(401)
  })
})
