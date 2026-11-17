import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds and fixtures are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedParties } from '../../../../../packages/factory-db/seed/parties'
import { seed as seedProduct } from '../../../../../packages/factory-db/seed/product'
import { seed as seedSales } from '../../../../../packages/factory-db/seed/sales'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../packages/factory-db/src/testing/second-brand'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { BRAND_ALPHA, BRAND_BETA } from '../../golden-flow/portal/testing/two-brands'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { DESIGN_KIND_WORDS, PAGE_TYPE_WORDS } from './rules'
import { EICAR, fakeScanner } from './scan/fake'
import { useScanner } from './scan/service'

/**
 * B-TH-083 (threads plan TH-7, N11; walls W25 / W26, tests T25 / T26) and B-TH-084 (G12). Owner rule 2026-11-16: "One brand must
 * not be able to see anything related to any other brand. But we, as the production unit, should be able to see it all."
 *
 * Measurement sheets are body data: a tick at upload files a PDF as MEASUREMENTS; in the office only people with
 * sales.measurements.view open it — the production manager's template holds it on purpose, finance's does not — and each opening
 * (download, preview) is recorded; everyone else gets 404 on the file and sees it LOCKED in the record's list and on a message
 * (no name). A person limited to brand A never opens brand B's sheet (T26); brand B's portal never reads brand A's sheet (T25).
 * Design files (Illustrator, EPS, Photoshop, ZIP) are accepted download-only and scanned like every file; SVG never.
 *
 * Two brands of one tenant: P1 (the seeds' customer, its order SEED-SO-0001: Brand Alpha) and the second brand of factory-db's
 * testing/second-brand.ts (SEED-SO-B001: Brand Beta). Run with `node scripts/factory/run-pg-tests.mjs platform/files/measurement-sheets`.
 */

let h: Harness
let app: FastifyInstance
let second: SecondBrand
const NS = 'files-measurement-sheets'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const THREADS: Permission[] = ['threads.read', 'threads.post']
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: [...permissions], companies: 'all', sites: 'all', parties }] })
const template = (key: string): readonly Permission[] => templateOf(key)!.permissions
const partner = (partyId: () => string): SessionContext => ({ audience: 'partner', tenantId: T, actorId: newId(), partyId: partyId(), grants: [{ permissions: ['files.read'], companies: 'all', sites: 'all', parties: 'all' }] })
const SESSIONS: Record<string, () => SessionContext> = {
  // Sales files the sheet (and holds the permission); the production manager and finance as their templates make them.
  sales: () => office(['files.read', 'files.upload', 'files.manage', 'sales.measurements.view', ...THREADS]),
  productionManager: () => office(template('production_manager')),
  finance: () => office(template('finance')),
  // Holds the permission, but only for brand A (RoleAssignment.partyIds).
  alphaOnly: () => office(['files.read', 'sales.measurements.view'], [P1]),
  // Reads the thread, not files: a message's files are counted, never dropped.
  threadOnly: () => office(['threads.read']),
  alphaPortal: () => partner(() => P1),
  betaPortal: () => partner(() => second.partyId),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `sheets-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
const announce = (body: Buffer, input: Json) => call('sales', 'POST', '/files', { companyId: companyA, sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...input })
async function uploaded(body: Buffer, input: Json): Promise<Json> {
  const announced = await announce(body, input)
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await call('sales', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up measurement sheet of the TH-7 test: ${text}`)
const openings = async (fileId: string): Promise<Array<{ audience: string; how: string }>> =>
  (await admin<{ audience: string; after: Json }>(`SELECT audience::text, after FROM "AuditLog" WHERE "recordType" = 'StoredFile' AND "recordId" = $1 AND action = 'files.measurementSheetOpened' ORDER BY at, id`, [fileId])).map((row) => ({ audience: row.audience, how: row.after.how }))

const ALPHA_SHEET = 'Brand Alpha rider measurements AX-100.pdf'
const BETA_SHEET = 'Brand Beta rider measurements BX-200.pdf'
let alphaSheet: Json
let betaSheet: Json

beforeAll(async () => {
  h = await startHarness('files_th7_sheets')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  // Each sheet ticked at upload and shared with its own brand's portal (the record's own party: B-TH-003).
  alphaSheet = await uploaded(pdf('alpha'), { kind: 'DOCUMENT', originalName: ALPHA_SHEET, contentType: 'application/pdf', recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER'], measurementSheet: true })
  betaSheet = await uploaded(pdf('beta'), { kind: 'DOCUMENT', originalName: BETA_SHEET, contentType: 'application/pdf', recordType: 'SalesOrder', recordId: second.salesOrderId, visibility: ['PARTNER'], measurementSheet: true })
}, 300_000)

afterAll(async () => {
  useScanner(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-083: the tick files a measurement sheet', () => {
  it('a ticked upload is a MEASUREMENTS file, shared only with its record’s own customer', async () => {
    expect(alphaSheet).toMatchObject({ category: 'MEASUREMENTS', visibility: ['OFFICE', 'PARTNER'], partyId: P1, status: 'AVAILABLE' })
    expect((await admin('SELECT category::text FROM "StoredFile" WHERE id = $1', [betaSheet.id]))[0]).toEqual({ category: 'MEASUREMENTS' })
  })

  it('refused in words as a certificate, or for a floor', async () => {
    const body = pdf('refused')
    const certificate = await announce(body, { kind: 'CERTIFICATE', originalName: 'Sheet.pdf', contentType: 'application/pdf', recordType: 'SalesOrder', recordId: SO1, measurementSheet: true })
    expect(certificate.status).toBe(400)
    expect(certificate.body.error.issues).toContainEqual({ path: 'body/measurementSheet', message: 'A measurement sheet is a document, an attachment or a photo of one.' })
    const floor = await announce(body, { kind: 'DOCUMENT', originalName: 'Sheet.pdf', contentType: 'application/pdf', recordType: 'SalesOrder', recordId: SO1, visibility: ['FLOOR'], measurementSheet: true })
    expect(floor.status).toBe(400)
    expect(floor.body.error.issues).toContainEqual({ path: 'body/measurementSheet', message: 'A measurement sheet is body data: it is never shared with a floor.' })
  })
})

describe('W25 / W26: only sales.measurements.view opens a sheet; each opening is recorded', () => {
  it('the production manager (his template holds it) opens the sheet; the download and the preview are each recorded', async () => {
    expect(template('production_manager')).toContain('sales.measurements.view')
    expect((await call('productionManager', 'GET', `/files/${alphaSheet.id}`)).body.file).toMatchObject({ id: alphaSheet.id, originalName: ALPHA_SHEET, category: 'MEASUREMENTS' })
    const listed = (await call('productionManager', 'GET', `/files?recordType=SalesOrder&recordId=${SO1}`)).body.files.find((file: Json) => file.id === alphaSheet.id)
    expect(listed).toMatchObject({ originalName: ALPHA_SHEET })
    expect(listed.locked).toBeUndefined()
    const before = (await openings(alphaSheet.id)).length
    expect((await call('productionManager', 'GET', `/files/${alphaSheet.id}/download`)).status).toBe(200)
    expect((await call('productionManager', 'GET', `/files/${alphaSheet.id}/preview`)).status).toBe(200)
    expect((await openings(alphaSheet.id)).slice(before)).toEqual([
      { audience: 'OFFICE', how: 'download' },
      { audience: 'OFFICE', how: 'preview' },
    ])
  })

  it('finance (no permission) gets 404 on the sheet, its download, preview, versions, history, document tag and carry; the list shows it locked, unnamed', async () => {
    expect(template('finance')).not.toContain('sales.measurements.view')
    const before = (await openings(alphaSheet.id)).length
    for (const url of [`/files/${alphaSheet.id}`, `/files/${alphaSheet.id}/download`, `/files/${alphaSheet.id}/preview`, `/files/${alphaSheet.id}/versions`, `/files/${alphaSheet.id}/history`]) {
      const answer = await call('finance', 'GET', url)
      expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(404)
      expect(JSON.stringify(answer.body)).not.toContain(ALPHA_SHEET)
    }
    expect((await call('finance', 'PUT', `/files/${alphaSheet.id}/document`, { category: 'OTHER', version: alphaSheet.version })).status).toBe(404)
    expect((await call('finance', 'POST', `/files/${alphaSheet.id}/use-on`, { recordType: 'Company', recordId: companyA })).status).toBe(404)
    const list = await call('finance', 'GET', `/files?recordType=SalesOrder&recordId=${SO1}`)
    expect(JSON.stringify(list.body)).not.toContain(ALPHA_SHEET)
    expect(list.body.files.find((file: Json) => file.id === alphaSheet.id)).toMatchObject({ locked: 'MEASUREMENTS', category: 'MEASUREMENTS', originalName: '', sha256: '', kind: 'DOCUMENT' })
    expect((await openings(alphaSheet.id)).length).toBe(before)
    // The record's documents read never lists a sheet (its tag is its lock, no document a rule asks for).
    const documents = await call('sales', 'GET', `/files/documents?recordType=SalesOrder&recordId=${SO1}`)
    expect(documents.status, JSON.stringify(documents.body)).toBe(200)
    expect(documents.body.documents.map((document: Json) => document.fileId)).not.toContain(alphaSheet.id)
  })

  it('on a message: the sheet is locked for finance, a file the reader may not see is counted; finance cannot attach it', async () => {
    const posted = await call('sales', 'POST', `/threads/SalesOrder/${SO1}/notes`, { body: 'The rider’s measurement sheet, for the pattern room.', attachments: [alphaSheet.id] })
    expect(posted.status, JSON.stringify(posted.body)).toBe(201)
    const messageId = posted.body.message.id
    const asFinance = (await call('finance', 'GET', `/threads/SalesOrder/${SO1}`)).body.messages.find((message: Json) => message.id === messageId)
    expect(asFinance.attachments).toEqual([expect.objectContaining({ id: alphaSheet.id, originalName: '', locked: 'MEASUREMENTS' })])
    expect(asFinance.hiddenAttachments).toBeUndefined()
    const asHolder = (await call('productionManager', 'GET', `/threads/SalesOrder/${SO1}`)).body.messages.find((message: Json) => message.id === messageId)
    expect(asHolder.attachments).toEqual([expect.objectContaining({ id: alphaSheet.id, originalName: ALPHA_SHEET })])
    expect(asHolder.attachments[0].locked).toBeUndefined()
    // B-TH-231 (B-TH-029): a reader of the thread who may not read files sees the count, never the file.
    const counted = (await call('threadOnly', 'GET', `/threads/SalesOrder/${SO1}`)).body.messages.find((message: Json) => message.id === messageId)
    expect(counted).toMatchObject({ attachments: [], hiddenAttachments: 1 })
    expect(template('finance')).toContain('threads.post')
    const refused = await call('finance', 'POST', `/threads/SalesOrder/${SO1}/notes`, { body: 'Forwarding it.', attachments: [alphaSheet.id] })
    expect(refused.status).toBe(400)
    expect(refused.body.error.issues).toEqual([{ path: 'body/attachments/0', message: 'File not found.' }])
  })
})

describe('T26 / T25: brand B never reads brand A’s sheet', () => {
  it('a person limited to brand A opens brand A’s sheet, never brand B’s (by id or in its order’s list)', async () => {
    expect((await call('alphaOnly', 'GET', `/files/${alphaSheet.id}`)).status).toBe(200)
    for (const url of [`/files/${betaSheet.id}`, `/files/${betaSheet.id}/download`]) expect((await call('alphaOnly', 'GET', url)).status, url).toBe(404)
    expect((await call('alphaOnly', 'GET', `/files?recordType=SalesOrder&recordId=${second.salesOrderId}`)).body.files).toEqual([])
  })

  it('each portal reads its own sheet (its opening recorded), never the other brand’s', async () => {
    const before = (await openings(alphaSheet.id)).length
    expect((await call('alphaPortal', 'GET', `/files/${alphaSheet.id}`)).body.file).toMatchObject({ id: alphaSheet.id, originalName: ALPHA_SHEET })
    expect((await call('alphaPortal', 'GET', `/files/${alphaSheet.id}/download`)).status).toBe(200)
    expect((await openings(alphaSheet.id)).slice(before)).toEqual([{ audience: 'PARTNER', how: 'download' }])
    for (const url of [`/files/${betaSheet.id}`, `/files/${betaSheet.id}/download`]) {
      const answer = await call('alphaPortal', 'GET', url)
      expect(answer.status, url).toBe(404)
      expect(JSON.stringify(answer.body)).not.toContain(BETA_SHEET)
    }
    expect((await call('alphaPortal', 'GET', `/files?recordType=SalesOrder&recordId=${second.salesOrderId}`)).body.files).toEqual([])
    expect((await call('betaPortal', 'GET', `/files/${alphaSheet.id}`)).status).toBe(404)
    const betaList = await call('betaPortal', 'GET', `/files?recordType=SalesOrder&recordId=${SO1}`)
    expect(JSON.stringify(betaList.body)).not.toContain(ALPHA_SHEET)
    expect(JSON.stringify(betaList.body)).not.toContain(BRAND_ALPHA.fileName)
    expect((await call('betaPortal', 'GET', `/files/${betaSheet.id}`)).body.file).toMatchObject({ originalName: BETA_SHEET })
    expect(BRAND_BETA.fileName).not.toBe(BETA_SHEET)
  })
})

describe('B-TH-084: design files are accepted download-only, scanned like every file; SVG never', () => {
  const psd = Buffer.from('8BPS made-up Photoshop artwork of Brand Alpha')

  it('a Photoshop file as an attachment: stored, opened as a download only, and a portal downloads it as it was sent', async () => {
    const file = await uploaded(psd, { kind: 'ATTACHMENT', originalName: 'Alpha logo AX-100.psd', contentType: 'image/vnd.adobe.photoshop', recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER'] })
    expect(file).toMatchObject({ status: 'AVAILABLE', kind: 'ATTACHMENT' })
    expect((await call('sales', 'GET', `/files/${file.id}/preview`)).body.preview).toMatchObject({ mode: 'download' })
    const outside = await call('alphaPortal', 'GET', `/files/${file.id}/download`)
    expect(outside.status, JSON.stringify(outside.body)).toBe(200)
    expect((await admin('SELECT "thumbnailKey" FROM "StoredFile" WHERE id = $1', [file.id]))[0]).toEqual({ thumbnailKey: null })
  })

  it('refused in words: a design file as a photo, a ZIP as an attachment, an SVG at all', async () => {
    const body = Buffer.from('made-up design bytes')
    const cases: Array<[Json, string]> = [
      [{ kind: 'PHOTO', originalName: 'Logo.ai', contentType: 'application/illustrator' }, DESIGN_KIND_WORDS],
      [{ kind: 'ATTACHMENT', originalName: 'Artwork.zip', contentType: 'application/zip' }, DESIGN_KIND_WORDS],
      [{ kind: 'ATTACHMENT', originalName: 'Logo.svg', contentType: 'image/svg+xml' }, PAGE_TYPE_WORDS],
    ]
    for (const [input, words] of cases) {
      const refused = await announce(body, { ...input, recordType: 'SalesOrder', recordId: SO1 })
      expect(refused.status, JSON.stringify(input)).toBe(400)
      expect(refused.body.error.issues).toContainEqual({ path: 'body/contentType', message: words })
    }
    const zip = await uploaded(Buffer.from('PK made-up artwork pack'), { kind: 'DOCUMENT', originalName: 'Artwork.zip', contentType: 'application/zip', recordType: 'SalesOrder', recordId: SO1 })
    expect(zip).toMatchObject({ status: 'AVAILABLE', kind: 'DOCUMENT' })
  })

  it('with a scanner on, an infected design file is held, never served', async () => {
    useScanner(fakeScanner())
    try {
      const announced = await announce(Buffer.from(EICAR, 'latin1'), { kind: 'DOCUMENT', originalName: 'Artwork.eps', contentType: 'application/postscript', recordType: 'SalesOrder', recordId: SO1 })
      expect(announced.status, JSON.stringify(announced.body)).toBe(201)
      expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: Buffer.from(EICAR, 'latin1') })).statusCode).toBe(200)
      const done = await call('sales', 'POST', `/files/${announced.body.file.id}/complete`)
      expect(done.body.file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'virus_found', scanStatus: 'INFECTED' })
      expect((await call('alphaPortal', 'GET', `/files/${announced.body.file.id}/download`)).status).toBe(404)
    } finally {
      useScanner(undefined)
    }
  })
})
