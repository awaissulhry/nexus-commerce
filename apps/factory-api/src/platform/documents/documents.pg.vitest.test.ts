import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import type { DocumentInput } from '@nexus/factory-domain/documents/model'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../files/service'
import { createGateway } from '../gateway/gateway'
import { systemContext } from '../outbox/system'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { storeDocumentPdf, type DocumentRequest } from './documents'
import { pdfFlatText as pdfText } from './testing/pdf-text'

/**
 * Company documents on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login through the scoped clients), the gateway on the local Redis under this file's own
 * prefix, and the local file store on a temporary folder (each tenant's FAKE R2 account). Each PDF is read back through
 * the files routes (the browser's download) and its text checked. Every company, tax number and address is FAKE.
 * Run with `node scripts/factory/run-pg-tests.mjs documents`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime

const tenantA = newId()
const tenantB = newId()
const company = newId()
const otherCompany = newId()
const bareCompany = newId()
const companyB = newId()
const user = newId()
const ddtId = newId()

const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  office: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['documents.view', 'files.read'])] },
  'office-other': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['documents.view', 'files.read'], [otherCompany])] },
  'files-only': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['files.read'])] },
  'office-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(['documents.view', 'files.read'])] },
}

const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string) => app.inject({ method, url, headers: { 'x-test-session': session } })
const office = (tenantId = tenantA) => callerFor(database, { audience: 'office', tenantId, actorId: user, grants: [], requestId: newId() })

const PARTY = { name: 'Motoabbigliamento Immaginario S.p.A.', address: { line1: 'Viale delle Prove 42', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' }, vatNumber: 'IT76543210009', sdiCode: 'FAKE001' }
const ddt = (fields: Partial<DocumentRequest['document']> = {}): DocumentRequest['document'] => ({
  type: 'DDT',
  language: 'it',
  number: '2026/000143',
  date: '2026-10-28',
  currency: 'EUR',
  party: PARTY,
  lines: [
    { code: 'JKT-01', description: 'Giacca in pelle bovina nera, taglia 50', quantity: '2', uom: 'PCS' },
    { code: 'GLV-02', description: 'Guanti in pelle, marrone, taglia L', quantity: '10', uom: 'PAIR' },
  ],
  transport: {
    reason: 'WORK_ON_ACCOUNT',
    transportBy: 'CARRIER',
    carrier: { name: 'Trasporti Esempio S.r.l.', vatNumber: 'IT11111110009' },
    startAt: '2026-10-28T13:30:00Z',
    appearance: 'Scatole di cartone',
    packages: 3,
    grossWeightKg: '12.5',
    destination: { name: 'Laboratorio Esempio', line1: 'Via Esempio 9', postalCode: '40128', city: 'Bologna', province: 'BO', country: 'IT' },
  },
  ...fields,
})
const invoiceCopy = (language: DocumentInput['language']): DocumentRequest['document'] => ({
  type: 'INVOICE_COPY',
  language,
  number: '2026/0101',
  date: '2026-10-05',
  currency: 'EUR',
  party: PARTY,
  lines: [{ code: 'JKT-01', description: 'Giacca in pelle', quantity: '2', uom: 'PCS', unitPrice: '250', amountMinor: 50000, vatRate: '22' }],
  totals: { netMinor: 50000, vat: [{ rate: '22', taxableMinor: 50000, vatMinor: 11000 }], grossMinor: 61000 },
  invoice: { kind: 'TD01', sdiId: '9999999999' },
})

/** The PDF of a stored file, the way a browser gets it: the files route's presigned download, then the local store. */
async function downloaded(fileId: string, session = 'office'): Promise<Buffer> {
  const presigned = await call(session, 'GET', `/files/${fileId}/download`)
  expect(presigned.statusCode, presigned.body).toBe(200)
  const fetched = await app.inject({ method: 'GET', url: presigned.json().download.url })
  expect(fetched.statusCode).toBe(200)
  expect(fetched.headers['content-type']).toBe('application/pdf')
  return fetched.rawPayload
}

beforeAll(async () => {
  db = await migratedDatabase('documents')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-documents-test-'))
  const legal = [
    `{"line1":"Via dei Conciatori Finti 1","postalCode":"20121","city":"Milano","province":"MI","country":"IT"}`,
    'IT12345670009',
    '12345670009',
    'MI',
    '0000001',
    '10000.00',
    'amministrazione@pec.pelletteria-fittizia.example',
    'Made up for tests',
  ]
  for (const [tenantId, slug] of [
    [tenantA, 'documents-a'],
    [tenantB, 'documents-b'],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
  }
  for (const [id, tenantId, code, name] of [
    [company, tenantA, 'PF', 'Pelletteria Fittizia S.r.l.'],
    [otherCompany, tenantA, 'OT', 'Altra Fittizia S.r.l.'],
    [companyB, tenantB, 'PB', 'Tenant B Fittizia S.r.l.'],
  ] as const) {
    await admin(
      `INSERT INTO "Company" (id, "tenantId", code, "legalName", address, "vatNumber", "fiscalCode", "reaOffice", "reaNumber", "shareCapital", pec, "documentFooter")
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      [id, tenantId, code, name, ...legal],
    )
  }
  // A company with no legal data yet: its documents are refused (c.c. art. 2250).
  await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [bareCompany, tenantA, 'Bare Fittizia'])

  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('storeDocumentPdf (GAP-008)', () => {
  it('stores a DDT PDF in the fiscal archive whose text has the c.c. art. 2250 legal block and the DPR 472/1996 fields', async () => {
    const { file, layout } = await storeDocumentPdf(files, office(), { companyId: company, recordType: 'Ddt', recordId: ddtId, document: ddt(), idempotencyKey: 'ddt-2026-000143' })
    expect(layout).toBe('DDT/1')
    expect(file).toMatchObject({ companyId: company, recordType: 'Ddt', recordId: ddtId, kind: 'FISCAL_ARCHIVE', contentType: 'application/pdf', status: 'AVAILABLE', visibility: ['OFFICE'] })
    expect(file.originalName).toBe('Documento di trasporto (DDT) 2026-000143.pdf')
    expect(Date.parse(file.retainUntil!) - Date.now()).toBeGreaterThan(9.99 * 365 * 24 * 3600 * 1000)
    const [stored] = await admin<{ storageKey: string }>('SELECT "storageKey" FROM "StoredFile" WHERE id = $1', [file.id])
    expect(stored!.storageKey).toMatch(new RegExp(`^legal/t/${tenantA}/c/${company}/`))

    const text = pdfText(await downloaded(file.id))
    // c.c. art. 2250: name, registered office, VAT and tax code, register office and number, REA, paid-up capital.
    for (const expected of [
      'Pelletteria Fittizia S.r.l.',
      'Sede legale: Via dei Conciatori Finti 1, 20121 Milano (MI)',
      'P. IVA IT12345670009 · C.F. 12345670009',
      'Registro Imprese di MI n. 12345670009 · REA MI-0000001',
      'Capitale sociale versato € 10.000,00',
      'PEC: amministrazione@pec.pelletteria-fittizia.example',
    ]) {
      expect(text, expected).toContain(expected)
    }
    // DPR 472/1996: number, date, recipient, carrier, goods with their quantities, and the transport.
    for (const expected of [
      'Documento di trasporto (DDT)',
      'Numero: 2026/000143',
      'Data: 28/10/2026',
      'Motoabbigliamento Immaginario S.p.A.',
      'Laboratorio Esempio',
      'Trasporti Esempio S.r.l.',
      'Causale del trasporto',
      'Conto lavorazione',
      'Trasporto a cura del',
      'Inizio trasporto (data e ora)',
      '28/10/2026 14:30',
      'Aspetto esteriore dei beni',
      'Scatole di cartone',
      'Numero colli',
      'Peso lordo (kg)',
      '12,5',
      'Giacca in pelle bovina nera, taglia 50',
      'Firma del destinatario',
    ]) {
      expect(text, expected).toContain(expected)
    }
  })

  it('audits the render as documents.render with the document\'s type, number and layout, and announces the file', async () => {
    const recordId = newId()
    const { file } = await storeDocumentPdf(files, office(), { companyId: company, recordType: 'Ddt', recordId, document: ddt({ number: '2026/000144' }) })
    const [audit] = await admin<{ action: string; after: Record<string, unknown> }>('SELECT action, after FROM "AuditLog" WHERE "recordId" = $1', [file.id])
    expect(audit).toMatchObject({ action: 'documents.render', after: { documentType: 'DDT', number: '2026/000144', layout: 'DDT/1', language: 'it', kind: 'FISCAL_ARCHIVE', sha256: file.sha256 } })
    const events = await admin('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1', [file.id])
    expect(events).toEqual([{ type: 'file.available', payload: { fileId: file.id, recordType: 'Ddt', recordId, kind: 'FISCAL_ARCHIVE' } }])
    const calls = await admin('SELECT operation, status FROM "IntegrationCall" WHERE "requestSummary"->>\'key\' LIKE $1', [`legal/t/${tenantA}/%`])
    expect(calls.map((entry) => entry.operation)).toContain('files.put')
  })

  it('says on an invoice copy that it is a courtesy copy (the legal invoice is the FatturaPA XML), in Italian and English', async () => {
    const italian = await storeDocumentPdf(files, office(), { companyId: company, recordType: 'Invoice', recordId: newId(), document: invoiceCopy('it') })
    expect(italian.file).toMatchObject({ kind: 'FISCAL_ARCHIVE', originalName: 'Fattura - copia di cortesia 2026-0101.pdf' })
    const it = pdfText(await downloaded(italian.file.id))
    expect(it).toContain('Fattura - copia di cortesia')
    expect(it).toContain('Copia di cortesia, priva di valore fiscale.')
    expect(it).toContain("L'originale è la fattura elettronica trasmessa tramite il Sistema di Interscambio")
    expect(it).toContain('Totale documento')

    const english = await storeDocumentPdf(files, office(), { companyId: company, recordType: 'Invoice', recordId: newId(), document: invoiceCopy('en') })
    const en = pdfText(await downloaded(english.file.id))
    expect(en).toContain('Invoice - courtesy copy')
    expect(en).toContain('Courtesy copy with no fiscal value.')
    expect(en).toContain('Paid-up share capital €10,000.00')
  })

  it('keeps a quote as a DOCUMENT without retention, shareable with a floor site like any file', async () => {
    const site = newId()
    await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'PF-1', 'Plant', 'PLANT')`, [site, tenantA, company])
    const quote = { ...invoiceCopy('it'), type: 'QUOTE' as const, number: 'Q-2026-0007', invoice: null, validUntil: '2026-11-30' }
    const { file } = await storeDocumentPdf(files, office(), { companyId: company, recordType: 'Quote', recordId: newId(), document: quote, visibility: ['FLOOR'], floorSiteId: site })
    expect(file).toMatchObject({ kind: 'DOCUMENT', retainUntil: null, visibility: ['OFFICE', 'FLOOR'], floorSiteId: site })
    expect(pdfText(await downloaded(file.id))).toContain('Valida fino al')
  })

  it('works for the worker (the tenant\'s system context), and gives the same answer to a repeated idempotency key', async () => {
    const system = callerFor(database, systemContext(tenantA, newId()))
    const request = { companyId: company, recordType: 'Ddt', recordId: newId(), document: ddt({ number: '2026/000150' }), idempotencyKey: 'ddt-2026-000150' }
    const first = await storeDocumentPdf(files, system, request)
    const again = await storeDocumentPdf(files, system, request)
    expect(again.file.id).toBe(first.file.id)
    expect(await admin('SELECT id FROM "StoredFile" WHERE "recordId" = $1', [request.recordId])).toHaveLength(1)
  })

  it('c.c. art. 2250: refuses a document of a company without its legal data, before anything is stored', async () => {
    const before = (await admin('SELECT count(*)::int AS n FROM "IntegrationCall"'))[0]!.n
    const refusal = await storeDocumentPdf(files, office(), { companyId: bareCompany, recordType: 'Ddt', recordId: newId(), document: ddt() }).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(ValidationError)
    expect((refusal as ValidationError).issues?.map((issue) => issue.path)).toEqual(['company/address', 'company/vatNumber', 'company/fiscalCode', 'company/rea'])
    expect((await admin('SELECT count(*)::int AS n FROM "IntegrationCall"'))[0]!.n).toBe(before)
    expect(await admin('SELECT id FROM "StoredFile" WHERE "companyId" = $1', [bareCompany])).toEqual([])
  })

  it('keeps tenants apart: another tenant cannot print with this tenant\'s company', async () => {
    await expect(storeDocumentPdf(files, office(tenantB), { companyId: company, recordType: 'Ddt', recordId: newId(), document: ddt() })).rejects.toMatchObject({ name: 'NotFoundError' })
  })
})

describe('GET /documents/sample (the letterhead preview)', () => {
  it('answers a sample PDF of each layout with the company\'s legal data and the sample banner, stored nowhere', async () => {
    const before = (await admin('SELECT count(*)::int AS n FROM "StoredFile"'))[0]!.n
    for (const [type, language, title] of [
      ['DDT', 'it', 'Documento di trasporto (DDT)'],
      ['QUOTE', 'en', 'Quotation'],
      ['PURCHASE_ORDER', 'it', 'Ordine di acquisto'],
      ['INVOICE_COPY', 'en', 'Invoice - courtesy copy'],
    ] as const) {
      const response = await call('office', 'GET', `/documents/sample?companyId=${company}&type=${type}&language=${language}`)
      expect(response.statusCode, response.body).toBe(200)
      expect(response.headers['content-type']).toBe('application/pdf')
      expect(response.headers['content-disposition']).toMatch(/^attachment; filename="/)
      const text = pdfText(response.rawPayload)
      expect(text).toContain(title)
      expect(text).toContain(language === 'it' ? 'ESEMPIO - documento non valido' : 'SAMPLE - not a valid document')
      expect(text).toContain('REA MI-0000001')
    }
    expect((await admin('SELECT count(*)::int AS n FROM "StoredFile"'))[0]!.n).toBe(before)
  })

  it('needs documents.view for the company, refuses incomplete legal data, and keeps tenants apart', async () => {
    expect((await call('files-only', 'GET', `/documents/sample?companyId=${company}&type=DDT`)).statusCode).toBe(403)
    expect((await call('office-other', 'GET', `/documents/sample?companyId=${company}&type=DDT`)).statusCode).toBe(403)
    expect((await call('office-other', 'GET', `/documents/sample?companyId=${otherCompany}&type=DDT`)).statusCode).toBe(200)
    const bare = await call('office', 'GET', `/documents/sample?companyId=${bareCompany}&type=QUOTE`)
    expect(bare.statusCode).toBe(400)
    expect(bare.json().error.issues.map((issue: { path: string }) => issue.path)).toContain('company/rea')
    expect((await call('office-b', 'GET', `/documents/sample?companyId=${company}&type=DDT`)).statusCode).toBe(404)
    expect((await call('office-b', 'GET', `/documents/sample?companyId=${companyB}&type=DDT`)).statusCode).toBe(200)
  })
})
