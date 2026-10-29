import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { Clock } from '@nexus/factory-domain/core/time'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { currentDocFor, useStyleComplianceClock } from './read'

/**
 * The style compliance tab (B-W1-20) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login, so row-level security and the …_product_guards triggers are real), the local
 * file store behind a FAKE R2 account for the signed PDFs. Every company, style, certificate, notified body and DoC
 * number is made up (notified body "0000" does not exist). Run with `node scripts/factory/run-pg-tests.mjs compliance`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
const clock: Clock = { now: () => new Date('2026-10-29T09:00:00.000Z') }

const quiet: Log = { info() {}, warn() {}, error() {} }
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyA2 = newId()
const companyB = newId()
const brand = newId()
const user = newId()
const scale = newId()
const jacket = newId() // PPE, a certificate covers 48 and 50, not 52; the DoC flows
const worn = newId() // PPE, BLK under an expired certificate, RED under a suspended one
const vest = newId() // not PPE
const branded = newId() // PPE for a brand with no registered office, no label template
const otherCompany = newId() // PPE of company A2
const styleB = newId()
const black = newId()
const wornBlack = newId()
const wornRed = newId()
const vestBlack = newId()
const label = newId()
const rev1 = newId()
const rev2 = newId()
const vestRev = newId()
const brandedRev = newId()
const otherRev = newId()
const certificateA = newId()

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.declarations.manage'
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: user, grants })
const SESSIONS: Record<string, SessionContext> = {
  manager: office(tenantA, [grant([VIEW, MANAGE, 'files.read', 'files.upload'])]),
  viewer: office(tenantA, [grant([VIEW, 'files.read'])]),
  noFiles: office(tenantA, [grant([VIEW, MANAGE])]),
  companyTwo: office(tenantA, [grant([VIEW, MANAGE, 'files.read', 'files.upload'], [companyA2])]),
  otherTenant: office(tenantB, [grant([VIEW, MANAGE, 'files.read', 'files.upload'])]),
  nobody: office(tenantA, [grant(['files.read', 'product.styles.view'])]),
  floor: { audience: 'floor', tenantId: tenantA, actorId: newId(), siteId: newId(), deviceId: newId(), grants: [grant(['floor.work', VIEW, MANAGE], [companyA])] },
  partner: { audience: 'partner', tenantId: tenantA, actorId: newId(), partyId: brand, grants: [grant([VIEW, MANAGE])] },
  link: { audience: 'link', tenantId: tenantA, linkId: newId(), partyId: brand, record: { type: 'Style', id: jacket }, grants: [grant([VIEW])] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const compliance = async (styleId: string, query = '', session = 'manager'): Promise<Json> => (await ok(session, 'GET', `/product/styles/${styleId}/compliance${query}`)).compliance
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% made-up signed document: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

/** Announce a signed PDF, send it to the local store, confirm it: the Owner's three steps. */
async function upload(styleId: string, revisionId: string, kind: string, language: string, body: Buffer, extra: Json = {}): Promise<Json> {
  const announced = await ok(
    'manager',
    'POST',
    `/product/styles/${styleId}/compliance/documents`,
    { revisionId, kind, language, originalName: `${kind.toLowerCase()}-${language}.pdf`, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body), ...extra },
    201,
  )
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  const confirmed = await ok('manager', 'POST', `/product/styles/${styleId}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
  return { ...confirmed, announced }
}

const cellsOf = (view: Json) => view.coverage.cells.map((cell: Json) => [cell.label, cell.status])
const statusesOf = (entries: Json[]) => entries.map((entry) => [entry.language, entry.state])
const docStatus = async (id: string) => (await admin<{ status: string }>('SELECT status FROM "ComplianceDocument" WHERE id = $1', [id]))[0]!.status
const reader = (tenantId = tenantA) => callerFor(database, { audience: 'office', tenantId, actorId: user, grants: [], requestId: newId() })

beforeAll(async () => {
  db = await migratedDatabase('style_compliance')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-style-compliance-test-'))
  useStyleComplianceClock(clock)

  for (const [tenantId, slug, companies] of [
    [tenantA, 'scomp-a', [companyA, companyA2]],
    [tenantB, 'scomp-b', [companyB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName", address) VALUES ($1, $2, $3, 'Giacche Fittizie S.r.l.', $4)`, [
        companyId,
        tenantId,
        `${slug}-${index}`,
        JSON.stringify({ line1: 'Via Inventata 1', postalCode: '00000', city: 'Testville', province: 'TT', country: 'IT' }),
      ])
    }
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
  }
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles) VALUES ($1, $2, 'BRAND-1', 'ORGANISATION', 'Marchio Inventato S.r.l.', '{CUSTOMER,BRAND}')`, [brand, tenantA])

  await admin(`INSERT INTO "SizeScale" (id, "tenantId", code, name) VALUES ($1, $2, 'TEST-EU', 'Test EU jacket')`, [scale, tenantA])
  for (const [seq, code] of [[1, '48'], [2, '50'], [3, '52']] as const) {
    await admin(`INSERT INTO "Size" (id, "tenantId", "scaleId", code, seq) VALUES ($1, $2, $3, $4, $5)`, [newId(), tenantA, scale, code, seq])
  }
  const style = (id: string, tenantId: string, companyId: string, code: string, scaleId: string, ppe: [string, string | null, string | null], brandPartyId: string | null = null) =>
    admin(
      `INSERT INTO "Style" (id, "tenantId", "companyId", code, name, "productType", "sizeScaleId", sizes, "baseSize", "ppeCategory", "ppeStandard", "ppeClass", "brandPartyId")
       VALUES ($1, $2, $3, $4, $4, 'JACKET', $5, '{48,50,52}', '50', $6, $7, $8, $9)`,
      [id, tenantId, companyId, code, scaleId, ...ppe, brandPartyId],
    )
  const PPE: [string, string, string] = ['CATEGORY_II', 'EN 17092-4:2020', 'A']
  await style(jacket, tenantA, companyA, 'TEST-JKT', scale, PPE)
  await style(worn, tenantA, companyA, 'TEST-JKT-WORN', scale, PPE)
  await style(vest, tenantA, companyA, 'TEST-VEST', scale, ['NOT_PPE', null, null])
  await style(branded, tenantA, companyA, 'TEST-JKT-BRAND', scale, PPE, brand)
  await style(otherCompany, tenantA, companyA2, 'TEST-JKT-A2', scale, PPE)
  const scaleB = newId()
  await admin(`INSERT INTO "SizeScale" (id, "tenantId", code, name) VALUES ($1, $2, 'TEST-EU', 'Test EU jacket')`, [scaleB, tenantB])
  await style(styleB, tenantB, companyB, 'TEST-JKT-B', scaleB, PPE)
  for (const [id, styleId, code] of [
    [black, jacket, 'BLK'],
    [wornBlack, worn, 'BLK'],
    [wornRed, worn, 'RED'],
    [vestBlack, vest, 'BLK'],
  ] as const) {
    await admin(`INSERT INTO "Colourway" (id, "tenantId", "styleId", code, name) VALUES ($1, $2, $3, $4, $4)`, [id, tenantA, styleId, code])
    for (const size of ['48', '50', '52']) {
      await admin(`INSERT INTO "Variant" (id, "tenantId", "styleId", "colourwayId", size, sku) VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), tenantA, styleId, id, size, `${id}-${code}-${size}`])
    }
  }

  // The garment label (Italian and English) names the maker; revision 1 of the jacket and the vest carry it.
  await admin(
    `INSERT INTO "LabelTemplate" (id, "tenantId", "companyId", code, revision, name, status, languages, "makerName", "makerAddress", layout, "widthMm", "heightMm")
     VALUES ($1, $2, $3, 'LBL-TEST', 1, 'Test label', 'ACTIVE', '{it,en}', 'Giacche Fittizie S.r.l.', 'Via Inventata 1, 00000 Testville (TT), IT', '{}', 40, 80)`,
    [label, tenantA, companyA],
  )
  for (const [id, styleId, labelId] of [
    [rev1, jacket, label],
    [vestRev, vest, label],
    [brandedRev, branded, null],
    [otherRev, otherCompany, label],
  ] as const) {
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status, "labelTemplateId", "releasedAt") VALUES ($1, $2, $3, 1, 'RELEASED', $4, now())`, [id, tenantA, styleId, labelId])
  }

  // Certificates: A covers the jacket in 48 and 50; the worn jacket's BLK is under an expired one, its RED a suspended one.
  const certificate = (id: string, number: string, status: string, validFrom: string, validTo: string) =>
    admin(
      `INSERT INTO "Certificate" (id, "tenantId", "companyId", standard, "ppeClass", number, "notifiedBodyName", "notifiedBodyNumber", "validFrom", "validTo", status)
       VALUES ($1, $2, $3, 'EN 17092-4:2020', 'A', $4, 'Test Notified Body', '0000', $5, $6, $7)`,
      [id, tenantA, companyA, number, validFrom, validTo, status],
    )
  const coverage = (certificateId: string, styleId: string, colourwayIds: string[], sizes: string[]) =>
    admin(`INSERT INTO "CertificateCoverage" (id, "tenantId", "certificateId", "styleId", "colourwayIds", sizes) VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), tenantA, certificateId, styleId, colourwayIds, sizes])
  await certificate(certificateA, 'TEST-CERT-0001', 'VALID', '2026-01-15', '2030-12-31')
  await coverage(certificateA, jacket, [], ['48', '50'])
  const expired = newId()
  const suspended = newId()
  await certificate(expired, 'TEST-CERT-0002', 'VALID', '2021-07-01', '2026-06-30')
  await certificate(suspended, 'TEST-CERT-0003', 'SUSPENDED', '2026-01-15', '2030-12-31')
  await coverage(expired, worn, [wornBlack], [])
  await coverage(suspended, worn, [wornRed], [])

  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: quiet })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }), clock }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useStyleComplianceClock(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the PPE class and the certificate coverage (PRD-270, QHS-103, QHS-051)', () => {
  it('shows a PPE jacket covered in 2 of 3 sizes, with the gap, its reason and the work order\'s words', async () => {
    const view = await compliance(jacket)
    expect(view.date).toBe('2026-10-29')
    expect(view.classification).toMatchObject({ isPpe: true, category: 'CATEGORY_II', standardCode: 'EN 17092', part: '4', edition: '2020', ppeClass: 'A', certificateRequired: true, documentsRequired: true, legalMaker: 'COMPANY' })
    expect(view.revision).toMatchObject({ id: rev1, revision: 1, status: 'RELEASED', isReleased: true, labelTemplate: { code: 'LBL-TEST', status: 'ACTIVE', languages: ['it', 'en'] } })
    expect(cellsOf(view)).toEqual([
      ['BLK 48', 'COVERED'],
      ['BLK 50', 'COVERED'],
      ['BLK 52', 'NOT_COVERED'],
    ])
    expect(view.coverage.cells[0]).toMatchObject({ offered: true, certificate: { id: certificateA, number: 'TEST-CERT-0001', validTo: '2030-12-31' }, daysToExpiry: 1524, expiringSoon: false })
    const gap = view.coverage.cells[2]
    expect(gap).toMatchObject({ certificate: null, reasons: [{ code: 'size_not_covered', certificateId: certificateA }] })
    expect(gap.message).toBe('Certificate TEST-CERT-0001 (EN 17092-4:2020, notified body 0000) does not cover size 52 of style TEST-JKT (it covers 48, 50).')
    expect(view.coverage.counts).toEqual({ cells: 3, offered: 3, covered: 2, expiringSoon: 0, notCovered: 1, expired: 0, suspended: 0 })
    expect(view.coverage.certificates).toEqual([expect.objectContaining({ sizes: ['48', '50'], certificate: expect.objectContaining({ number: 'TEST-CERT-0001', notifiedBodyName: 'Test Notified Body', status: 'VALID' }) })])
    const certificate = view.blockers.find((check: Json) => check.code === 'CERTIFICATE')
    expect(certificate).toMatchObject({
      blocks: ['PRODUCTION', 'LABELS', 'SHIPPING'],
      message: 'No valid certificate covers BLK 52 today (Reg. (EU) 2016/425): 1 of 3 cell(s).',
      problems: [{ path: `cells/${black}/52/certificate`, message: `BLK 52: ${gap.message}` }],
    })
    expect(view.checks.map((check: Json) => [check.code, check.state]).slice(0, 2)).toEqual([
      ['REVISION', 'OK'],
      ['LABEL_TEMPLATE', 'OK'],
    ])
  })

  it('shows an expired certificate as EXPIRED and a suspended one as SUSPENDED, never as covered', async () => {
    const view = await compliance(worn)
    expect(cellsOf(view)).toEqual([
      ['BLK 48', 'EXPIRED'],
      ['BLK 50', 'EXPIRED'],
      ['BLK 52', 'EXPIRED'],
      ['RED 48', 'SUSPENDED'],
      ['RED 50', 'SUSPENDED'],
      ['RED 52', 'SUSPENDED'],
    ])
    expect(view.coverage.cells[0]).toMatchObject({ certificate: { number: 'TEST-CERT-0002', validTo: '2026-06-30', status: 'VALID' }, daysToExpiry: -121 })
    expect(view.coverage.cells[0].message).toMatch(/TEST-CERT-0002 .* expired: its last valid day was 2026-06-30\./)
    expect(view.coverage.cells[3]).toMatchObject({ certificate: { number: 'TEST-CERT-0003', status: 'SUSPENDED' } })
    expect(view.coverage.counts).toMatchObject({ covered: 0, expired: 3, suspended: 3 })
    expect(view.blockers.find((check: Json) => check.code === 'CERTIFICATE').message).toBe('No valid certificate covers BLK 48, BLK 50, BLK 52, RED 48, RED 50, RED 52 today (Reg. (EU) 2016/425): 6 of 6 cell(s).')
    // The same certificate before its last day: covered, and expiring within 60 days.
    const earlier = await compliance(worn, '?date=2026-05-01')
    expect(earlier.coverage.cells[0]).toMatchObject({ status: 'COVERED', daysToExpiry: 60, expiringSoon: true })
    expect(earlier.coverage.counts).toMatchObject({ covered: 3, expiringSoon: 3, suspended: 3 })
  })

  it('needs no certificate, DoC or leaflet for a style that is not PPE', async () => {
    const view = await compliance(vest)
    expect(view.classification).toMatchObject({ isPpe: false, certificateRequired: false, documentsRequired: false })
    expect(view.coverage.required).toBe(false)
    expect(new Set(view.coverage.cells.map((cell: Json) => cell.status))).toEqual(new Set(['NOT_REQUIRED']))
    expect(view.documents).toMatchObject({ required: false, maker: null })
    expect(view.checks.map((check: Json) => check.state)).toEqual(['OK', 'OK', 'NOT_REQUIRED', 'NOT_REQUIRED', 'NOT_REQUIRED'])
    expect(view.blockers).toEqual([])
    const refused = await call('manager', 'POST', `/product/styles/${vest}/compliance/documents`, {
      revisionId: vestRev,
      kind: 'DECLARATION_OF_CONFORMITY',
      language: 'it',
      originalName: 'doc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
    })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toBe('Style TEST-VEST is not PPE: it has no Declaration of Conformity or user information leaflet.')
  })
})

describe('the signed DoC and leaflet per revision and language (LOG-020; Reg. (EU) 2016/425 art. 8(7)(8), art. 15)', () => {
  let doc1: Json

  it('starts with both missing in the label\'s languages, and shipping blocked', async () => {
    const view = await compliance(jacket)
    expect(view.documents).toMatchObject({ required: true, expectedLanguages: ['it', 'en'], maker: { makerPartyId: null, makerName: 'Giacche Fittizie S.r.l.' } })
    expect(statusesOf(view.documents.declarations)).toEqual([
      ['it', 'MISSING'],
      ['en', 'MISSING'],
    ])
    const blocker = view.blockers.find((check: Json) => check.code === 'DECLARATION_OF_CONFORMITY')
    expect(blocker).toMatchObject({ blocks: ['SHIPPING'], message: 'The EU Declaration of Conformity for revision 1 is not on file in it, en (Reg. (EU) 2016/425 art. 8(8), art. 15): 2 of 2 language(s).' })
  })

  it('uploads the signed Italian DoC for revision 1: a DRAFT, the PDF confirmed, then ISSUED and kept ten years', async () => {
    const body = pdf('DoC it rev 1')
    const done = await upload(jacket, rev1, 'DECLARATION_OF_CONFORMITY', 'it', body, { number: 'DOC-TEST-0001' })
    expect(done.announced.document).toMatchObject({ status: 'DRAFT', revision: 1, language: 'it', number: 'DOC-TEST-0001', currentFile: null, pendingUpload: true })
    expect(done.announced.file).toMatchObject({ recordType: 'ComplianceDocument', recordId: done.announced.document.id, kind: 'DOCUMENT', status: 'PENDING_UPLOAD', visibility: ['OFFICE'] })
    doc1 = done.document
    expect(doc1).toMatchObject({ status: 'ISSUED', issuedAt: '2026-10-29T09:00:00.000Z', revision: 1, versions: 1, makerName: 'Giacche Fittizie S.r.l.', standards: ['EN 17092-4:2020'] })
    expect(doc1.currentFile).toMatchObject({ id: done.file.id, sha256: sha(body) })
    expect(doc1.files).toEqual([expect.objectContaining({ id: done.file.id, status: 'AVAILABLE', current: true, retainUntil: '2036-10-29T09:00:00.000Z' })])

    const audit = await admin('SELECT action, before, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [doc1.id])
    expect(audit.map((row) => row.action)).toEqual(['product.compliance.prepareDocument', 'product.compliance.issueDocument'])
    expect(audit[1]).toMatchObject({ before: { status: 'DRAFT' }, after: { status: 'ISSUED', fileId: done.file.id } })
    const events = await admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['style.compliance_document_issued', doc1.id])
    expect(events).toEqual([{ payload: { styleId: jacket, code: 'TEST-JKT', documentId: doc1.id, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 1, fileId: done.file.id, supersededDocumentIds: [] } }])

    const view = await compliance(jacket)
    expect(statusesOf(view.documents.declarations)).toEqual([
      ['it', 'CURRENT'],
      ['en', 'MISSING'],
    ])
    // Confirming the same file again changes nothing.
    await ok('manager', 'POST', `/product/styles/${jacket}/compliance/documents/${doc1.id}/files/${done.file.id}/complete`)
    expect(await admin('SELECT 1 FROM "AuditLog" WHERE "recordId" = $1', [doc1.id])).toHaveLength(2)
  })

  it('keeps a leaflet per language', async () => {
    await upload(jacket, rev1, 'USER_INFORMATION', 'it', pdf('leaflet it'))
    await upload(jacket, rev1, 'USER_INFORMATION', 'en', pdf('leaflet en'))
    await upload(jacket, rev1, 'USER_INFORMATION', 'de', pdf('leaflet de'))
    const view = await compliance(jacket)
    // The label's languages first, then any other on file.
    expect(statusesOf(view.documents.leaflets)).toEqual([
      ['it', 'CURRENT'],
      ['en', 'CURRENT'],
      ['de', 'CURRENT'],
    ])
    expect(view.checks.find((check: Json) => check.code === 'USER_INFORMATION')).toMatchObject({ state: 'OK', message: 'The user information leaflet for revision 1 is on file in it, en, de.' })
    expect(view.checks.find((check: Json) => check.code === 'DECLARATION_OF_CONFORMITY')).toMatchObject({ state: 'BLOCKED', problems: [{ path: 'documents/DECLARATION_OF_CONFORMITY/en' }] })
    const listed = await ok('viewer', 'GET', `/product/styles/${jacket}/compliance/documents?kind=USER_INFORMATION`)
    expect(listed.documents.map((document: Json) => document.language)).toEqual(['de', 'en', 'it'])
  })

  it('replaces the DoC with a new version and keeps the old one; its number never changes', async () => {
    const body = pdf('DoC it rev 1, signed again')
    const done = await upload(jacket, rev1, 'DECLARATION_OF_CONFORMITY', 'it', body)
    expect(done.announced.document.id).toBe(doc1.id)
    expect(done.document).toMatchObject({ status: 'ISSUED', versions: 2, currentFile: { id: done.file.id } })
    expect(done.document.files.map((file: Json) => [file.id, file.status, file.current])).toEqual([
      [done.file.id, 'AVAILABLE', true],
      [doc1.currentFile.id, 'AVAILABLE', false],
    ])
    const events = await admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['style.compliance_document_replaced', doc1.id])
    expect(events).toEqual([{ payload: expect.objectContaining({ fileId: done.file.id, previousFileId: doc1.currentFile.id, revision: 1 }) }])
    const versions = await ok('viewer', 'GET', `/product/styles/${jacket}/compliance/documents/${doc1.id}`)
    expect(versions.document.files).toHaveLength(2)

    const renumber = await call('manager', 'POST', `/product/styles/${jacket}/compliance/documents`, {
      revisionId: rev1,
      kind: 'DECLARATION_OF_CONFORMITY',
      language: 'it',
      number: 'DOC-TEST-9999',
      originalName: 'doc.pdf',
      contentType: 'application/pdf',
      sizeBytes: body.length,
      sha256: sha(body),
    })
    expect(renumber.statusCode).toBe(400)
    expect(renumber.json().error.issues).toEqual([{ path: 'body/number', message: "This document is ISSUED with number DOC-TEST-0001; an issued document's number never changes." }])

    // The download is the files platform's 60-second presigned GET, of the version asked for.
    const { download } = await ok('viewer', 'GET', `/product/styles/${jacket}/compliance/documents/${doc1.id}/files/${doc1.currentFile.id}/download`)
    const fetched = await app.inject({ method: 'GET', url: download.url })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.rawPayload.equals(pdf('DoC it rev 1'))).toBe(true)
  })

  it('says the DoC is for an older revision once revision 2 is released, until revision 2\'s is uploaded', async () => {
    await admin(`UPDATE "StyleRevision" SET status = 'OBSOLETE' WHERE id = $1`, [rev1])
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status, "labelTemplateId", "releasedAt") VALUES ($1, $2, $3, 2, 'RELEASED', $4, now())`, [rev2, tenantA, jacket, label])

    const view = await compliance(jacket)
    expect(view.revision).toMatchObject({ id: rev2, revision: 2, isReleased: true })
    expect(view.revisions.map((entry: Json) => [entry.revision, entry.status])).toEqual([
      [2, 'RELEASED'],
      [1, 'OBSOLETE'],
    ])
    const italian = view.documents.declarations[0]
    expect(italian).toMatchObject({ language: 'it', state: 'OLDER_REVISION', revision: 2, document: { id: doc1.id, revision: 1 } })
    expect(italian.message).toBe('The EU Declaration of Conformity in it is for revision 1, an older revision: upload the signed one for revision 2.')
    expect(statusesOf(view.documents.leaflets)).toEqual([
      ['it', 'OLDER_REVISION'],
      ['en', 'OLDER_REVISION'],
      ['de', 'OLDER_REVISION'],
    ])
    expect(view.blockers.map((check: Json) => check.code)).toEqual(['CERTIFICATE', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'])
    // The tab can still look at revision 1, whose garments keep their own DoC.
    const old = await compliance(jacket, `?revisionId=${rev1}`)
    expect(old.documents.declarations[0]).toMatchObject({ state: 'CURRENT', revision: 1 })
    expect(old.checks[0]).toMatchObject({ code: 'REVISION', state: 'BLOCKED' })

    // The shipping step's question (B-W1-49): nothing for revision 2 yet, revision 1's for revision 1.
    expect(await reader().withClient((client) => currentDocFor(client, jacket, 2, 'DECLARATION_OF_CONFORMITY', 'it'))).toBeNull()
    const forOne = await reader().withClient((client) => currentDocFor(client, jacket, 1, 'DECLARATION_OF_CONFORMITY', 'it'))
    expect(forOne).toMatchObject({ document: { id: doc1.id, revision: 1, status: 'ISSUED', styleId: jacket, companyId: companyA }, file: { contentType: 'application/pdf', sha256: sha(pdf('DoC it rev 1, signed again')) } })
  })

  it('issues revision 2\'s DoC and supersedes revision 1\'s, which still goes with revision 1\'s garments', async () => {
    const done = await upload(jacket, rev2, 'DECLARATION_OF_CONFORMITY', 'it', pdf('DoC it rev 2'))
    expect(done.document).toMatchObject({ status: 'ISSUED', revision: 2 })
    expect(await docStatus(doc1.id)).toBe('SUPERSEDED')
    const events = await admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['style.compliance_document_issued', done.document.id])
    expect(events[0]!.payload).toMatchObject({ revision: 2, supersededDocumentIds: [doc1.id] })
    const audit = await admin('SELECT action, after FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [doc1.id])
    expect(audit.at(-1)).toMatchObject({ action: 'product.compliance.supersedeDocument', after: { status: 'SUPERSEDED', by: done.document.id, revision: 2 } })

    const view = await compliance(jacket)
    expect(view.documents.declarations[0]).toMatchObject({ language: 'it', state: 'CURRENT', document: { id: done.document.id } })
    expect((await reader().withClient((client) => currentDocFor(client, jacket, 2, 'DECLARATION_OF_CONFORMITY', 'it')))?.document.id).toBe(done.document.id)
    expect((await reader().withClient((client) => currentDocFor(client, jacket, 1, 'DECLARATION_OF_CONFORMITY', 'it')))?.document).toMatchObject({ id: doc1.id, status: 'SUPERSEDED' })
  })

  it('refuses a document that is not a PDF, an unknown language, another style\'s revision, and a maker it cannot name', async () => {
    const body = (overrides: Json) => ({ revisionId: rev2, kind: 'DECLARATION_OF_CONFORMITY', language: 'en', originalName: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'b'.repeat(64), ...overrides })
    const wrong = await call('manager', 'POST', `/product/styles/${jacket}/compliance/documents`, body({ language: 'xx', contentType: 'image/png' }))
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/language', 'body/contentType'])
    const other = await call('manager', 'POST', `/product/styles/${jacket}/compliance/documents`, body({ revisionId: vestRev }))
    expect(other.statusCode).toBe(400)
    expect(other.json().error.issues).toEqual([{ path: 'body/revisionId', message: 'Not a revision of the style.' }])
    // A brand's style without a label template: the brand is the maker, and it has no registered office on record.
    const unknown = await call('manager', 'POST', `/product/styles/${branded}/compliance/documents`, body({ revisionId: brandedRev }))
    expect(unknown.statusCode).toBe(409)
    expect(unknown.json().error.message).toMatch(/The maker the document names is not known: set a garment label template on revision 1, or give the brand its registered address/)
    expect(await admin('SELECT 1 FROM "ComplianceDocument" WHERE "styleId" = $1', [branded])).toEqual([])
  })
})

describe('who sees and writes it', () => {
  it('lets compliance.declarations.manage with files.upload write; a viewer reads only; without files.upload nothing is left behind', async () => {
    const body = { revisionId: otherRev, kind: 'DECLARATION_OF_CONFORMITY', language: 'it', originalName: 'doc.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'c'.repeat(64) }
    expect((await call('viewer', 'POST', `/product/styles/${otherCompany}/compliance/documents`, body)).statusCode).toBe(403)
    expect((await call('noFiles', 'POST', `/product/styles/${otherCompany}/compliance/documents`, body)).statusCode).toBe(403)
    expect(await admin('SELECT 1 FROM "ComplianceDocument" WHERE "styleId" = $1', [otherCompany])).toEqual([])
    expect((await call('nobody', 'GET', `/product/styles/${jacket}/compliance`)).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/product/styles/${jacket}/compliance` })).statusCode).toBe(401)
    expect((await call('viewer', 'GET', `/product/styles/${jacket}/compliance`)).statusCode).toBe(200)
  })

  it('keeps the walls: another company\'s and another tenant\'s styles are not found', async () => {
    // The company wall: a role over company A2 only sees A2's style, not company A's.
    expect((await call('companyTwo', 'GET', `/product/styles/${jacket}/compliance`)).statusCode).toBe(404)
    const [document] = await admin<{ id: string }>('SELECT id::text AS id FROM "ComplianceDocument" WHERE "styleId" = $1 LIMIT 1', [jacket])
    expect((await call('companyTwo', 'GET', `/product/styles/${jacket}/compliance/documents/${document!.id}`)).statusCode).toBe(404)
    expect((await call('manager', 'GET', `/product/styles/${jacket}/compliance/documents/${document!.id}`)).statusCode).toBe(200)
    expect((await call('companyTwo', 'GET', `/product/styles/${otherCompany}/compliance`)).statusCode).toBe(200)
    // The tenant wall (row-level security): tenant B reads nothing of tenant A, and the reverse.
    expect((await call('otherTenant', 'GET', `/product/styles/${jacket}/compliance`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/product/styles/${jacket}/compliance/documents`)).statusCode).toBe(404)
    expect((await call('manager', 'GET', `/product/styles/${styleB}/compliance`)).statusCode).toBe(404)
    expect(await reader(tenantB).withClient((client) => currentDocFor(client, jacket, 2, 'DECLARATION_OF_CONFORMITY', 'it'))).toBeNull()
  })

  it('gives the floor, the portal and links nothing here', async () => {
    for (const session of ['floor', 'partner', 'link']) {
      expect((await call(session, 'GET', `/product/styles/${jacket}/compliance`)).statusCode, session).toBe(403)
      expect((await call(session, 'GET', `/product/styles/${jacket}/compliance/documents`)).statusCode, session).toBe(403)
    }
  })
})

