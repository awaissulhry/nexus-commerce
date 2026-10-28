import { randomBytes } from 'node:crypto'
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
import { runTick, type CronSettings } from '../../../core/cron'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { storeGeneratedFile } from '../../../platform/files/files'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { useCertificatesClock } from './certificates'
import { certificateExpiryCron, runCertificateExpiry } from './expiry'

/**
 * The certificate register on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login through the scoped clients, so row-level security and the …_product_guards triggers are
 * real), the local file store behind a FAKE R2 account for the certificates' PDFs, and the scheduler's expiry cron on
 * the local Redis. Every company, style, certificate and notified body is made up (the notified body "0000" does not
 * exist). Run with `node scripts/factory/run-pg-tests.mjs compliance`.
 */

type Json = Record<string, any>
interface MovableClock extends Clock {
  set(instant: string): void
}
function movableClock(start: string): MovableClock {
  let current = new Date(start).getTime()
  return { now: () => new Date(current), set: (instant) => void (current = new Date(instant).getTime()) }
}

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let localRoot: string
let files: FilesRuntime
let clock: MovableClock

const quiet: Log = { info() {}, warn() {}, error() {} }
const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyA2 = newId()
const companyB = newId()
const brandA = newId()
const riderParty = newId()
const supplierA = newId()
const user = newId()
const scaleA = newId()
const styleA = newId()
const bareStyle = newId()
const endStyle = newId()
const styleB = newId()
const black = newId()
const red = newId()
const bareColourway = newId()
const endColourway = newId()
const colourwayB = newId()
const protector = newId()
const insideProfile = newId()
const outsideProfile = newId()

const VIEW = 'compliance.certificates.view'
const MANAGE = 'compliance.certificates.manage'
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  manager: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant([VIEW, MANAGE])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant([VIEW])] },
  'company-two': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant([VIEW, MANAGE], [companyA2])] },
  nobody: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['files.read'])] },
  'files-admin': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['files.read', 'files.delete', 'files.manage'])] },
  writer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['threads.read', 'threads.post'])] },
  'manager-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant([VIEW, MANAGE, 'threads.read', 'threads.post'])] },
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })

let serial = 0
const certificateBody = (overrides: Json = {}): Json => ({
  companyId: companyA,
  standard: 'EN 17092-4:2020',
  ppeClass: 'A',
  number: `TEST-CERT-${String(++serial).padStart(4, '0')}`,
  notifiedBodyName: 'Test Notified Body',
  notifiedBodyNumber: '0000',
  modelReference: 'TEST-JKT-01',
  validFrom: '2026-01-15',
  validTo: '2030-12-31',
  ...overrides,
})

async function draft(overrides: Json = {}, session = 'manager'): Promise<Json> {
  const response = await call(session, 'POST', '/compliance/certificates', certificateBody(overrides))
  expect(response.statusCode, response.body).toBe(201)
  return response.json().certificate
}

/** The notified body's file on the certificate, as the files module stores it (kind CERTIFICATE unless said). */
async function attach(certificateId: string, options: { contentType?: string; kind?: 'CERTIFICATE' | 'DOCUMENT'; tenantId?: string; companyId?: string | null } = {}): Promise<void> {
  const contentType = options.contentType ?? 'application/pdf'
  const body = contentType === 'application/pdf' ? Buffer.from('%PDF-1.4\n% made-up test certificate\n%%EOF\n') : Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const caller = callerFor(database, { audience: 'office', tenantId: options.tenantId ?? tenantA, actorId: user, grants: [], requestId: newId() })
  await storeGeneratedFile(files, caller, {
    companyId: options.companyId === undefined ? companyA : options.companyId,
    recordType: 'Certificate',
    recordId: certificateId,
    kind: options.kind ?? 'CERTIFICATE',
    originalName: contentType === 'application/pdf' ? 'certificate.pdf' : 'certificate.png',
    contentType,
    body,
  })
}

async function registered(overrides: Json = {}): Promise<Json> {
  const created = await draft(overrides)
  await attach(created.id, { companyId: created.companyId })
  const issued = await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: created.version })
  expect(issued.statusCode, issued.body).toBe(200)
  return issued.json().certificate
}

async function cover(certificate: Json, body: Json, session = 'manager'): Promise<Json> {
  const response = await call(session, 'POST', `/compliance/certificates/${certificate.id}/coverage`, body)
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}

const gate = (body: Json, session = 'manager') => call(session, 'POST', '/compliance/certificates/gate', body)
const auditOf = (recordId: string) => admin('SELECT action, "recordType", before, after, reason, audience FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [recordId])
const eventsOf = (type: string, subject: string) => admin('SELECT type, subject, "companyId", payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', [type, subject])
const statusOf = async (certificateId: string) => (await admin<{ status: string }>('SELECT status FROM "Certificate" WHERE id = $1', [certificateId]))[0]!.status

beforeAll(async () => {
  db = await migratedDatabase('certificates')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-certificates-test-'))
  clock = movableClock('2026-10-28T09:00:00.000Z')
  useCertificatesClock(clock)

  for (const [tenantId, slug, companies] of [
    [tenantA, 'cert-a', [companyA, companyA2]],
    [tenantB, 'cert-b', [companyB]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, 'Giacche Fittizie S.r.l.')`, [companyId, tenantId, `${slug}-${index}`])
    }
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
  }
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles) VALUES ($1, $2, 'BRAND-1', 'ORGANISATION', 'Marchio Inventato S.r.l.', '{CUSTOMER,BRAND}')`, [brandA, tenantA])
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles) VALUES ($1, $2, 'RIDER-1', 'PERSON', 'Pilota Inventato', '{CUSTOMER}')`, [riderParty, tenantA])
  await admin(`INSERT INTO "Party" (id, "tenantId", code, kind, "legalName", roles) VALUES ($1, $2, 'SUPP-1', 'ORGANISATION', 'Protezioni Inventate S.r.l.', '{SUPPLIER}')`, [supplierA, tenantA])

  // A jacket in sizes 48, 50, 52 with their body measures (chest and height), two colourways, and a style no
  // certificate covers; tenant B has a jacket of its own.
  await admin(`INSERT INTO "SizeScale" (id, "tenantId", code, name) VALUES ($1, $2, 'TEST-EU', 'Test EU jacket')`, [scaleA, tenantA])
  const measures = (chest: [string, string], height: [string, string]) => ({ chest: { min: chest[0], max: chest[1], unit: 'cm' }, height: { min: height[0], max: height[1], unit: 'cm' } })
  for (const [seq, code, body] of [
    [1, '48', measures(['94', '98'], ['170', '176'])],
    [2, '50', measures(['98', '102'], ['174', '180'])],
    [3, '52', measures(['102', '106'], ['178', '184'])],
  ] as const) {
    await admin(`INSERT INTO "Size" (id, "tenantId", "scaleId", code, seq, "bodyMeasures") VALUES ($1, $2, $3, $4, $5, $6)`, [newId(), tenantA, scaleA, code, seq, JSON.stringify(body)])
  }
  const style = (id: string, tenantId: string, companyId: string, code: string, scaleId: string) =>
    admin(
      `INSERT INTO "Style" (id, "tenantId", "companyId", code, name, "productType", "sizeScaleId", sizes, "baseSize", "ppeCategory", "ppeStandard", "ppeClass", "mtmAllowed")
       VALUES ($1, $2, $3, $4, $4, 'JACKET', $5, '{48,50,52}', '50', 'CATEGORY_II', 'EN 17092-4:2020', 'A', true)`,
      [id, tenantId, companyId, code, scaleId],
    )
  await style(styleA, tenantA, companyA, 'TEST-JKT', scaleA)
  await style(bareStyle, tenantA, companyA, 'TEST-JKT-BARE', scaleA)
  await style(endStyle, tenantA, companyA, 'TEST-JKT-END', scaleA)
  const scaleB = newId()
  await admin(`INSERT INTO "SizeScale" (id, "tenantId", code, name) VALUES ($1, $2, 'TEST-EU', 'Test EU jacket')`, [scaleB, tenantB])
  await style(styleB, tenantB, companyB, 'TEST-JKT-B', scaleB)
  for (const [id, tenantId, styleId, code] of [
    [black, tenantA, styleA, 'BLK'],
    [red, tenantA, styleA, 'RED'],
    [bareColourway, tenantA, bareStyle, 'BLK'],
    [endColourway, tenantA, endStyle, 'BLK'],
    [colourwayB, tenantB, styleB, 'BLK'],
  ] as const) {
    await admin(`INSERT INTO "Colourway" (id, "tenantId", "styleId", code, name) VALUES ($1, $2, $3, $4, $4)`, [id, tenantId, styleId, code])
  }
  await admin(
    `INSERT INTO "Item" (id, "tenantId", "companyId", code, name, kind, "baseUom", "purchaseUom", "consumptionUom", "isPpeComponent")
     VALUES ($1, $2, $3, 'TEST-PRO-1', 'Test shoulder protector', 'PROTECTOR', 'PCS', 'PCS', 'PCS', true)`,
    [protector, tenantA, companyA],
  )
  // Two riders' profiles: one inside the sizes 48-50's body measures, one with a chest outside them.
  for (const [id, riderName, chest] of [
    [insideProfile, 'Rider Inside', '99.5'],
    [outsideProfile, 'Rider Outside', '110'],
  ] as const) {
    await admin(
      `INSERT INTO "MeasurementProfile" (id, "tenantId", "partyId", "riderName", "garmentType", revision, measurements, "takenAt", "takenBy", "privacyNoticeRef", "privacyNoticeAt")
       VALUES ($1, $2, $3, $4, 'JACKET', 1, $5, now(), 'Test Fitter', 'TEST-NOTICE-1', now())`,
      [id, tenantA, riderParty, riderName, JSON.stringify({ chest: { value: chest, unit: 'cm' }, height: { value: '176', unit: 'cm' }, sleeve: { value: '63', unit: 'cm' } })],
    )
  }

  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: redis.connect(), prefix: redis.prefix, secrets, sleep: async () => {}, log: quiet })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }), clock })
  useFiles(files)
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
  useCertificatesClock(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the certificate register (QHS-103)', () => {
  it('types in a draft with its audit row, and refuses a wrong class, notified body number or a validity over five years (PPE Regulation 2016/425 Annex V)', async () => {
    const created = await draft()
    expect(created).toMatchObject({ companyId: companyA, status: 'DRAFT', version: 1, nextStatuses: ['VALID', 'WITHDRAWN'], hasPdf: false, coverageCount: 0, coverage: [] })
    expect(created.daysToExpiry).toBe(1525)
    expect(await auditOf(created.id)).toMatchObject([{ action: 'compliance.certificates.create', recordType: 'Certificate', audience: 'OFFICE', after: { number: created.number, status: 'DRAFT' } }])

    const wrong = await call('manager', 'POST', '/compliance/certificates', certificateBody({ ppeClass: 'AA', notifiedBodyNumber: '12', validTo: '2031-01-16' }))
    expect(wrong.statusCode).toBe(400)
    expect(wrong.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/notifiedBodyNumber', 'body/ppeClass', 'body/validTo'])
    expect((await call('manager', 'POST', '/compliance/certificates', certificateBody({ number: created.number }))).statusCode).toBe(409)
    expect((await call('manager', 'POST', '/compliance/certificates', certificateBody({ companyId: companyB }))).json().error.issues).toEqual([{ path: 'body/companyId', message: 'Not a company of the tenant.' }])
    expect((await call('manager', 'POST', '/compliance/certificates', certificateBody({ companyId: null }))).statusCode).toBe(400)
  })

  it('lets only compliance.certificates.manage over the holder write, and checks the session first', async () => {
    expect((await call('viewer', 'POST', '/compliance/certificates', certificateBody())).statusCode).toBe(403)
    expect((await call('company-two', 'POST', '/compliance/certificates', certificateBody())).statusCode).toBe(403)
    expect((await call('nobody', 'GET', '/compliance/certificates')).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: '/compliance/certificates' })).statusCode).toBe(401)
    // A brand-held certificate has no company: it is every company's, so the second company's manager may keep it.
    const brandHeld = await draft({ companyId: null, holderPartyId: brandA }, 'company-two')
    expect(brandHeld).toMatchObject({ companyId: null, holderPartyId: brandA })
  })

  it('edits a draft, guarded by its version', async () => {
    const created = await draft()
    const edited = await call('manager', 'PATCH', `/compliance/certificates/${created.id}`, { version: 1, note: 'Typed from the test PDF', modelReference: 'TEST-JKT-02' })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().certificate).toMatchObject({ version: 2, note: 'Typed from the test PDF', modelReference: 'TEST-JKT-02' })
    const stale = await call('manager', 'PATCH', `/compliance/certificates/${created.id}`, { version: 1, note: 'Late' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatchObject({ code: 'conflict', issues: [{ path: 'version', message: 'The current version is 2.' }] })
    expect((await call('manager', 'PATCH', `/compliance/certificates/${created.id}`, { version: 2, ppeClass: 'B' })).statusCode).toBe(400)
  })

  it('PPE Regulation 2016/425: registers (issues) a certificate only with the notified body\'s PDF on the record', async () => {
    const created = await draft()
    const without = await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: 1 })
    expect(without.statusCode).toBe(409)
    expect(without.json().error).toMatchObject({ code: 'invalid_state', issues: [{ path: 'state', message: "the certificate's PDF from the notified body, uploaded on the certificate" }] })
    // A picture of it, or the PDF filed as another kind of document, is not the certificate's PDF.
    await attach(created.id, { contentType: 'image/png' })
    await attach(created.id, { kind: 'DOCUMENT' })
    expect((await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: 1 })).statusCode).toBe(409)

    await attach(created.id)
    const issued = await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: 1 })
    expect(issued.statusCode, issued.body).toBe(200)
    expect(issued.json().certificate).toMatchObject({ status: 'VALID', version: 2, hasPdf: true, statusReason: null, statusChangedAt: '2026-10-28T09:00:00.000Z', nextStatuses: ['SUSPENDED', 'WITHDRAWN', 'EXPIRED'] })
    expect((await auditOf(created.id)).at(-1)).toMatchObject({ action: 'compliance.certificates.issue', before: { status: 'DRAFT' }, after: { status: 'VALID' } })

    // Registered: only its status moves now.
    const edit = await call('manager', 'PATCH', `/compliance/certificates/${created.id}`, { version: 2, note: 'x' })
    expect(edit.statusCode).toBe(409)
    expect(edit.json().error.code).toBe('invalid_state')
    expect((await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: 2 })).statusCode).toBe(409)
  })

  it('refuses to register a certificate whose validity already ended', async () => {
    const created = await draft({ validFrom: '2021-10-01', validTo: '2026-09-30' })
    await attach(created.id)
    const late = await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: 1 })
    expect(late.statusCode).toBe(409)
    expect(late.json().error.issues).toEqual([{ path: 'state', message: 'a validity that has not ended (its last valid day was 2026-09-30)' }])
  })

  it('suspends with a reason, reinstates, and withdraws for good', async () => {
    const certificate = await registered()
    expect((await call('manager', 'POST', `/compliance/certificates/${certificate.id}/suspend`, { version: certificate.version })).statusCode).toBe(400)
    const suspended = await call('manager', 'POST', `/compliance/certificates/${certificate.id}/suspend`, { version: certificate.version, reason: 'Surveillance audit pending' })
    expect(suspended.json().certificate).toMatchObject({ status: 'SUSPENDED', statusReason: 'Surveillance audit pending', nextStatuses: ['VALID', 'WITHDRAWN', 'EXPIRED'] })
    expect((await auditOf(certificate.id)).at(-1)).toMatchObject({ action: 'compliance.certificates.suspend', reason: 'Surveillance audit pending', before: { status: 'VALID' }, after: { status: 'SUSPENDED' } })
    const reinstated = await call('manager', 'POST', `/compliance/certificates/${certificate.id}/reinstate`, { version: suspended.json().certificate.version })
    expect(reinstated.json().certificate).toMatchObject({ status: 'VALID', statusReason: null })
    const withdrawn = await call('manager', 'POST', `/compliance/certificates/${certificate.id}/withdraw`, { version: reinstated.json().certificate.version, reason: 'Withdrawn by the notified body' })
    expect(withdrawn.json().certificate).toMatchObject({ status: 'WITHDRAWN', nextStatuses: [] })
    const version = withdrawn.json().certificate.version
    expect((await call('manager', 'POST', `/compliance/certificates/${certificate.id}/reinstate`, { version })).statusCode).toBe(409)
    expect((await call('manager', 'POST', `/compliance/certificates/${certificate.id}/coverage`, { version, styleId: styleA })).statusCode).toBe(409)
    // A draft typed by mistake is withdrawn too (it is kept, never deleted).
    const mistake = await draft()
    expect((await call('manager', 'POST', `/compliance/certificates/${mistake.id}/withdraw`, { version: 1, reason: 'Typed twice' })).json().certificate.status).toBe('WITHDRAWN')
  })
})

describe('the certificate PDF (Reg. (EU) 2016/425 art. 8(3))', () => {
  it('PPE Regulation 2016/425 art. 8(3): an issued certificate\'s PDF is kept ten years after its last valid day and cannot be deleted before', async () => {
    const created = await draft({ validTo: '2030-12-31' })
    await attach(created.id, { contentType: 'image/png' })
    await attach(created.id)
    await call('manager', 'POST', `/compliance/certificates/${created.id}/issue`, { version: 1 })
    const filesOf = () => admin<{ id: string; contentType: string; retainUntil: Date | null; version: number }>('SELECT id, "contentType", "retainUntil", version FROM "StoredFile" WHERE "recordId" = $1 ORDER BY "contentType"', [created.id])
    const [pdf, picture] = await filesOf()
    // The end of 31 December 2040 in Rome (UTC+1 in winter).
    expect(pdf).toMatchObject({ contentType: 'application/pdf', retainUntil: new Date('2040-12-31T23:00:00.000Z'), version: 2 })
    // Only the PDF of kind CERTIFICATE is the certificate; a picture of it is not kept by this rule.
    expect(picture).toMatchObject({ contentType: 'image/png', retainUntil: null })
    // (storeGeneratedFile writes on the server clock, the register on the test's: find the row by its action.)
    expect((await auditOf(pdf!.id)).filter((row) => row.action === 'files.setRetention')).toMatchObject([{ after: { retainUntil: '2040-12-31T23:00:00.000Z' }, reason: expect.stringContaining('art. 8(3)') }])

    const refused = await call('files-admin', 'DELETE', `/files/${pdf!.id}?reason=${encodeURIComponent('Not needed any more')}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('invalid_state')
    // Nor by any login straight in the database (the …_files_guards trigger), nor by moving the date earlier.
    await expect(admin(`UPDATE "StoredFile" SET status = 'DELETED', "deletedAt" = now() WHERE id = $1`, [pdf!.id])).rejects.toThrow(/retained/)
    await expect(admin(`UPDATE "StoredFile" SET "retainUntil" = '2031-01-01' WHERE id = $1`, [pdf!.id])).rejects.toThrow(/only moves later/)
    expect((await filesOf())[0]).toMatchObject({ retainUntil: new Date('2040-12-31T23:00:00.000Z') })
    // The picture, kept by no rule, can be deleted.
    expect((await call('files-admin', 'DELETE', `/files/${picture!.id}`)).statusCode).toBe(200)
  })
})

describe("a certificate's thread (SCR-051)", () => {
  it('opens on the certificate: its company, and its party only when a brand holds it', async () => {
    const own = await registered({ number: 'TEST-THREAD-0001' })
    const note = await call('writer', 'POST', `/threads/Certificate/${own.id}/notes`, { body: 'Renewal asked of the notified body.' })
    expect(note.statusCode, note.body).toBe(201)
    expect(note.json().thread).toMatchObject({ recordType: 'Certificate', recordId: own.id, companyId: companyA, siteId: null, partyId: null, status: 'OPEN' })
    const read = await call('writer', 'GET', `/threads/Certificate/${own.id}`)
    expect(read.json().messages.map((message: Json) => message.body)).toEqual(['Renewal asked of the notified body.'])

    const brandHeld = await draft({ companyId: null, holderPartyId: brandA, number: 'TEST-THREAD-0002' })
    expect((await call('writer', 'POST', `/threads/Certificate/${brandHeld.id}/notes`, { body: 'The brand holds this one.' })).json().thread).toMatchObject({ companyId: null, partyId: brandA })
    const supplierHeld = await draft({ companyId: null, holderPartyId: supplierA, standard: 'EN 1621-1:2012', ppeClass: '2', number: 'TEST-THREAD-0003' })
    expect((await call('writer', 'POST', `/threads/Certificate/${supplierHeld.id}/notes`, { body: 'A protector supplier holds this one.' })).json().thread).toMatchObject({ companyId: null, partyId: null })

    expect((await call('writer', 'GET', `/threads/Certificate/${newId()}`)).statusCode).toBe(404)
    expect((await call('manager-b', 'GET', `/threads/Certificate/${own.id}`)).statusCode).toBe(404)
    expect((await call('manager-b', 'POST', `/threads/Certificate/${own.id}/notes`, { body: 'x' })).statusCode).toBe(404)
  })
})

describe('coverage (PRD-281, PRD-288)', () => {
  it('covers a style in some colourways and sizes, with made-to-measure units, audited on the coverage and the certificate', async () => {
    const certificate = await registered()
    const { coverage, certificate: after } = await cover(certificate, { version: certificate.version, styleId: styleA, colourwayIds: [black], sizes: ['48', '50'], allowsMadeToMeasure: true })
    expect(coverage).toMatchObject({ styleId: styleA, itemId: null, style: { id: styleA, code: 'TEST-JKT' }, colourwayIds: [black], sizes: ['48', '50'], allowsMadeToMeasure: true, status: 'ACTIVE' })
    expect(after).toMatchObject({ version: certificate.version + 1, coverageCount: 1, coverage: [{ id: coverage.id }] })
    expect(await auditOf(coverage.id)).toMatchObject([{ action: 'compliance.certificates.addCoverage', recordType: 'CertificateCoverage', after: { certificateId: certificate.id, styleId: styleA } }])
    expect((await auditOf(certificate.id)).at(-1)).toMatchObject({ action: 'compliance.certificates.addCoverage', after: { coverageAdded: coverage.id } })
  })

  it('keeps one active coverage per certificate and style, also when two adds race; archiving one lets a new one in', async () => {
    const certificate = await registered()
    const both = await Promise.all([
      call('manager', 'POST', `/compliance/certificates/${certificate.id}/coverage`, { styleId: styleA, sizes: ['50'] }),
      call('manager', 'POST', `/compliance/certificates/${certificate.id}/coverage`, { styleId: styleA, sizes: ['52'] }),
    ])
    expect(both.map((response) => response.statusCode).sort()).toEqual([201, 409])
    expect((await admin('SELECT id FROM "CertificateCoverage" WHERE "certificateId" = $1 AND status = $2', [certificate.id, 'ACTIVE'])).length).toBe(1)
    const again = await call('manager', 'POST', `/compliance/certificates/${certificate.id}/coverage`, { styleId: styleA })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toMatch(/already covers style TEST-JKT: archive that coverage first/)

    const kept = both.find((response) => response.statusCode === 201)!.json().coverage
    const archived = await call('manager', 'POST', `/compliance/certificates/${certificate.id}/coverage/${kept.id}/archive`, { version: kept.version, reason: 'Sizes corrected' })
    expect(archived.statusCode, archived.body).toBe(200)
    expect(archived.json().coverage).toMatchObject({ status: 'ARCHIVED', version: kept.version + 1 })
    expect((await call('manager', 'POST', `/compliance/certificates/${certificate.id}/coverage/${kept.id}/archive`, { version: kept.version + 1 })).statusCode).toBe(409)
    await cover(certificate, { styleId: styleA, sizes: ['48', '50', '52'] })
    // The coverage is archived, never removed: the gate's history stays.
    expect((await admin('SELECT status FROM "CertificateCoverage" WHERE "certificateId" = $1 ORDER BY "createdAt"', [certificate.id])).map((row) => row.status)).toEqual(['ARCHIVED', 'ACTIVE'])
  })

  it("refuses a size outside the style's range, another style's colourway, sizes on an item, and another tenant's style", async () => {
    const certificate = await registered()
    const at = `/compliance/certificates/${certificate.id}/coverage`
    expect((await call('manager', 'POST', at, { styleId: styleA, sizes: ['56'] })).json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/sizes/0'])
    expect((await call('manager', 'POST', at, { styleId: styleA, colourwayIds: [bareColourway] })).json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/colourwayIds/0'])
    expect((await call('manager', 'POST', at, { itemId: protector, sizes: ['50'] })).json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/sizes'])
    expect((await call('manager', 'POST', at, { styleId: styleA, itemId: protector })).statusCode).toBe(400)
    expect((await call('manager', 'POST', at, { styleId: styleB })).json().error.issues).toEqual([{ path: 'body/styleId', message: 'Not a style of the tenant.' }])
    expect((await call('viewer', 'POST', at, { styleId: styleA })).statusCode).toBe(403)
    // A protector's certificate covers the item.
    const { coverage } = await cover(certificate, { itemId: protector })
    expect(coverage).toMatchObject({ itemId: protector, item: { code: 'TEST-PRO-1' }, colourwayIds: [], sizes: [] })
  })
})

describe('the certificate gate (QHS-051)', () => {
  let gated: Json
  let suspendedOnly: Json

  beforeAll(async () => {
    // Every certificate above covers styleA in other ways; the gate here asks about the bare style and one certificate.
    gated = await registered({ number: 'TEST-GATE-0001' })
    await cover(gated, { styleId: bareStyle, sizes: ['48', '50'], allowsMadeToMeasure: true })
    suspendedOnly = await registered({ number: 'TEST-GATE-0002', ppeClass: 'A' })
  })

  it('PPE Regulation 2016/425: answers which valid certificate covers a style, colourway and size', async () => {
    const answer = await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '50' })
    expect(answer.statusCode, answer.body).toBe(200)
    expect(answer.json()).toMatchObject({
      allowed: true,
      outcome: 'covered',
      route: 'SIZE',
      date: '2026-10-28',
      size: '50',
      certificate: { id: gated.id, number: 'TEST-GATE-0001', standard: 'EN 17092-4:2020', ppeClass: 'A', notifiedBodyNumber: '0000', validTo: '2030-12-31' },
      reasons: [],
    })
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '50' }, 'viewer')).statusCode).toBe(200)
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '50' }, 'nobody')).statusCode).toBe(403)
  })

  it('PPE Regulation 2016/425: refuses a size the certificate does not cover, a day after its validity, and a style no certificate covers', async () => {
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '52' })).json()).toMatchObject({ allowed: false, outcome: 'refused', reasons: [{ code: 'size_not_covered', certificateId: gated.id }] })
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '50', date: '2031-01-01' })).json().reasons).toMatchObject([{ code: 'certificate_expired' }])
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '50', date: '2026-01-14' })).json().reasons).toMatchObject([{ code: 'certificate_not_yet_valid' }])
    await cover(suspendedOnly, { styleId: bareStyle, sizes: ['52'] })
    const suspended = await call('manager', 'POST', `/compliance/certificates/${suspendedOnly.id}/suspend`, { version: suspendedOnly.version + 1, reason: 'Suspended for the test' })
    expect(suspended.statusCode, suspended.body).toBe(200)
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '52' })).json().reasons.map((reason: Json) => reason.code).sort()).toEqual(['certificate_not_valid', 'size_not_covered'])
    expect((await gate({ styleId: styleB, colourwayId: colourwayB, size: '50' }, 'manager-b')).json()).toMatchObject({ allowed: false, reasons: [{ code: 'no_certificate' }] })
  })

  it('PPE Regulation 2016/425 Annex III: covers a made-to-measure unit inside the covered sizes\' body measures and refuses one outside, naming the point', async () => {
    const inside = await gate({ styleId: bareStyle, colourwayId: bareColourway, measurementProfileId: insideProfile })
    expect(inside.json()).toMatchObject({ allowed: true, route: 'MADE_TO_MEASURE', measurementProfileId: insideProfile, certificate: { id: gated.id } })
    const outside = await gate({ styleId: bareStyle, colourwayId: bareColourway, measurementProfileId: outsideProfile })
    expect(outside.json()).toMatchObject({ allowed: false, route: 'MADE_TO_MEASURE' })
    const reasons = outside.json().reasons as Json[]
    expect(reasons.find((reason) => reason.certificateId === gated.id)).toMatchObject({ code: 'measurement_outside', point: 'chest' })
    expect(reasons.find((reason) => reason.certificateId === suspendedOnly.id)).toMatchObject({ code: 'certificate_not_valid' })
  })

  it('asks about exactly one of a size and a profile, of a colourway of the style', async () => {
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway })).statusCode).toBe(400)
    expect((await gate({ styleId: bareStyle, colourwayId: bareColourway, size: '50', measurementProfileId: insideProfile })).statusCode).toBe(400)
    expect((await gate({ styleId: bareStyle, colourwayId: black, size: '50' })).json().error.issues).toEqual([{ path: 'body/colourwayId', message: 'Not a colourway of the style.' }])
    expect((await gate({ styleId: newId(), colourwayId: black, size: '50' })).statusCode).toBe(404)
  })
})

describe('lists (SCR-050)', () => {
  it('filters by status, by "expiring soon" and by the covered style, inside the caller\'s scope', async () => {
    const soon = await registered({ number: 'TEST-SOON-0001', validFrom: '2021-12-01', validTo: '2026-11-30' })
    const valid = (await call('manager', 'GET', '/compliance/certificates?status=VALID')).json()
    expect(valid.today).toBe('2026-10-28')
    expect(valid.certificates.every((certificate: Json) => certificate.status === 'VALID')).toBe(true)
    expect(valid.certificates[0]).toMatchObject({ id: soon.id, daysToExpiry: 33 })
    expect((await call('manager', 'GET', '/compliance/certificates?expiringWithinDays=60')).json().certificates.map((certificate: Json) => certificate.number)).toEqual(['TEST-SOON-0001'])
    expect((await call('manager', 'GET', `/compliance/certificates?styleId=${bareStyle}`)).json().certificates.map((certificate: Json) => certificate.number).sort()).toEqual(['TEST-GATE-0001', 'TEST-GATE-0002'])
    // The second company's staff see its own and the brand-held ones, not the first company's.
    const scoped = (await call('company-two', 'GET', '/compliance/certificates')).json().certificates as Json[]
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.every((certificate) => certificate.companyId === null)).toBe(true)
    expect((await call('company-two', 'GET', `/compliance/certificates/${soon.id}`)).statusCode).toBe(404)
    expect((await call('manager', 'GET', `/compliance/certificates/${soon.id}`)).json().certificate).toMatchObject({ number: 'TEST-SOON-0001', hasPdf: true })
  })
})

describe('the tenant wall', () => {
  it("another tenant's manager finds none of this tenant's certificates, styles or coverage", async () => {
    const certificate = await registered({ number: 'TEST-WALL-0001' })
    const own = await draft({ companyId: companyB, number: 'TEST-WALL-0001' }, 'manager-b')
    expect(own.number).toBe('TEST-WALL-0001')
    expect((await call('manager-b', 'GET', '/compliance/certificates')).json().certificates.map((entry: Json) => entry.id)).toEqual([own.id])
    expect((await call('manager-b', 'GET', `/compliance/certificates/${certificate.id}`)).statusCode).toBe(404)
    expect((await call('manager-b', 'PATCH', `/compliance/certificates/${certificate.id}`, { version: certificate.version, note: 'x' })).statusCode).toBe(404)
    expect((await call('manager-b', 'POST', `/compliance/certificates/${certificate.id}/withdraw`, { version: certificate.version, reason: 'x' })).statusCode).toBe(404)
    expect((await call('manager-b', 'POST', `/compliance/certificates/${certificate.id}/coverage`, { styleId: styleB })).statusCode).toBe(404)
    expect((await call('manager-b', 'POST', `/compliance/certificates/${own.id}/coverage`, { styleId: styleA })).json().error.issues).toEqual([{ path: 'body/styleId', message: 'Not a style of the tenant.' }])
    expect((await gate({ styleId: styleA, colourwayId: black, size: '50' }, 'manager-b')).statusCode).toBe(404)
    expect(await statusOf(certificate.id)).toBe('VALID')
  })
})

describe('expiry (the scheduler)', () => {
  let ending: Json
  let suspendedEnding: Json

  beforeAll(async () => {
    clock.set('2026-10-28T09:00:00.000Z')
    ending = await registered({ number: 'TEST-END-0001', validFrom: '2021-11-01', validTo: '2026-10-31' })
    await cover(ending, { styleId: endStyle })
    suspendedEnding = await registered({ number: 'TEST-END-0002', validFrom: '2021-11-02', validTo: '2026-11-01' })
    const suspended = await call('manager', 'POST', `/compliance/certificates/${suspendedEnding.id}/suspend`, { version: suspendedEnding.version, reason: 'Suspended before it ends' })
    expect(suspended.statusCode, suspended.body).toBe(200)
  })

  it('warns once per threshold before the last valid day', async () => {
    expect((await gate({ styleId: endStyle, colourwayId: endColourway, size: '50' })).json()).toMatchObject({ allowed: true, certificate: { id: ending.id } })
    const first = await runCertificateExpiry({ database, log: quiet, clock })
    // TEST-END-0001 (3 days left: the 7-day warning) and TEST-SOON-0001 (33 days left: the 90-day one); not the suspended one.
    expect(first).toMatchObject({ today: '2026-10-28', expired: 0, warned: 2, failed: 0 })
    const warnings = await eventsOf('compliance.certificate_expiring', ending.id)
    expect(warnings).toMatchObject([{ payload: { certificateId: ending.id, number: 'TEST-END-0001', validTo: '2026-10-31', daysLeft: 3, thresholdDays: 7 }, companyId: companyA }])
    expect(await eventsOf('compliance.certificate_expiring', suspendedEnding.id)).toEqual([])
    expect((await runCertificateExpiry({ database, log: quiet, clock })).warned).toBe(0)
    expect(await eventsOf('compliance.certificate_expiring', ending.id)).toHaveLength(1)
  })

  it('expires a certificate once with two schedulers, by the business date in Europe/Rome', async () => {
    // 23:30 UTC on 31 October is already 1 November in Rome (UTC+1 after the clocks changed): the day after the last.
    clock.set('2026-10-31T23:30:00.000Z')
    const job = certificateExpiryCron({ database, log: quiet, clock })
    const one: CronSettings = { redis: redis.connect(), prefix: redis.prefix, log: quiet, holder: 'scheduler-1' }
    const two: CronSettings = { redis: redis.connect(), prefix: redis.prefix, log: quiet, holder: 'scheduler-2' }
    const at = new Date('2026-10-31T23:20:00.000Z')
    expect((await Promise.all([runTick(job, at, one), runTick(job, at, two)])).sort()).toEqual(['ran', 'taken'])
    expect(await statusOf(ending.id)).toBe('EXPIRED')
    expect(await eventsOf('compliance.certificate_expired', ending.id)).toMatchObject([
      { companyId: companyA, payload: { certificateId: ending.id, number: 'TEST-END-0001', validTo: '2026-10-31', previousStatus: 'VALID' } },
    ])
    expect((await auditOf(ending.id)).filter((row) => row.action === 'compliance.certificates.expire')).toMatchObject([
      { audience: 'SYSTEM', before: { status: 'VALID' }, after: { status: 'EXPIRED', statusReason: 'Past its last valid day, 2026-10-31.' } },
    ])
    // Its last valid day is today in Rome: not expired yet.
    expect(await statusOf(suspendedEnding.id)).toBe('SUSPENDED')
  })

  it('expires once even when two runs race without the lock, a suspended certificate included', async () => {
    clock.set('2026-11-02T09:00:00.000Z')
    const runs = await Promise.all([runCertificateExpiry({ database, log: quiet, clock }), runCertificateExpiry({ database, log: quiet, clock })])
    expect(runs.map((run) => run.expired).reduce((sum, count) => sum + count, 0)).toBe(1)
    expect(runs.map((run) => run.failed)).toEqual([0, 0])
    expect(await statusOf(suspendedEnding.id)).toBe('EXPIRED')
    expect(await eventsOf('compliance.certificate_expired', suspendedEnding.id)).toMatchObject([{ payload: { previousStatus: 'SUSPENDED' } }])
    expect((await auditOf(suspendedEnding.id)).filter((row) => row.action === 'compliance.certificates.expire')).toHaveLength(1)
    expect(await eventsOf('compliance.certificate_expired', ending.id)).toHaveLength(1)
  })

  it('PPE Regulation 2016/425: the gate refuses a garment whose only certificate expired', async () => {
    const answer = await gate({ styleId: endStyle, colourwayId: endColourway, size: '50' })
    expect(answer.json()).toMatchObject({ allowed: false, date: '2026-11-02', reasons: [{ code: 'certificate_expired', certificateId: ending.id }] })
    expect(answer.json().reasons).toHaveLength(1)
    const detail = (await call('manager', 'GET', `/compliance/certificates/${ending.id}`)).json().certificate
    expect(detail).toMatchObject({ status: 'EXPIRED', nextStatuses: [], daysToExpiry: -2, statusReason: 'Past its last valid day, 2026-10-31.' })
  })
})
