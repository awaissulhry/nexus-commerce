import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { USE_ON_WORDS } from './use-on'
// B-TH-231: the picker's targets come from the search index.
import { callerFor } from '../../core/command'
import { systemContext } from '../outbox/system'
import { rebuildIndex } from '../search/indexing'
import { loadIndexers } from '../search/registry'

/**
 * B-TH-024 (threads plan TH-2, N8; wall test T25 extended; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand"): carry a file to another record — POST /files/:fileId/use-on copies it (kind and category kept,
 * the copy naming its source) onto a record the person may write, of the same customer or of none; the record's file list says
 * where each copy came from. A copy of brand A's file onto brand B's record is refused in words and nothing is stored; shared
 * outside, a copy reaches the TARGET record's own customer only. Two brands of one tenant: P1 (SEED-SO-0001, its accepted quote;
 * here Brand Alpha) and the second brand of factory-db's testing/second-brand.ts (SEED-SO-B001, here Brand Beta).
 * Run with `node scripts/factory/run-pg-tests.mjs platform/files/use-on`.
 */

let h: Harness
let app: FastifyInstance
let second: SecondBrand
const NS = 'files-use-on'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
const Q1 = seedUuid(NS, 'link:P1:record')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const SESSIONS: Record<string, () => SessionContext> = {
  office: () => office(['files.read', 'files.upload', 'files.manage']),
  alphaOnly: () => office(['files.read', 'files.upload'], [P1]),
  reader: () => office(['files.read']),
  // ---- B-TH-231: the picker (it finds records as search does: their view permissions), and a person who may not share files.
  picker: () => office(['files.read', 'files.upload', 'files.manage', 'orders.view', 'quotes.view']),
  uploaderOnly: () => office(['files.read', 'files.upload']),
  // ---- end B-TH-231
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `use-on-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up file of the use-on test: ${text}`)
async function uploaded(name: string, record: { recordType: string; recordId: string }): Promise<Json> {
  const body = pdf(name)
  const announced = await call('office', 'POST', '/files', { companyId: companyA, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...record })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await call('office', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}
const countFiles = async (): Promise<number> => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "tenantId" = $1', [T]))[0]!.n

let alphaFile: Json
let betaFile: Json
let ourFile: Json

beforeAll(async () => {
  h = await startHarness('files_use_on')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  alphaFile = await uploaded(BRAND_ALPHA.fileName, { recordType: 'SalesOrder', recordId: SO1 })
  // What the file is (a tag set by the module that uploads it): the copy keeps it.
  await admin(`UPDATE "StoredFile" SET category = 'ARTWORK' WHERE id = $1`, [alphaFile.id])
  betaFile = await uploaded(BRAND_BETA.fileName, { recordType: 'SalesOrder', recordId: second.salesOrderId })
  ourFile = await uploaded('Our care leaflet.pdf', { recordType: 'Company', recordId: companyA })
  // B-TH-231: the orders and quotes in the search index (the picker finds records as global search does).
  const routesRoot = fileURLToPath(new URL('../..', import.meta.url))
  await rebuildIndex(callerFor(h.database, systemContext(T, 'use-on-targets-pg-test')), await loadIndexers(routesRoot), { recordTypes: ['SalesOrder', 'Quote'], key: `use-on-targets-${newId()}` })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('T25 (extended): carry a file to another record (B-TH-024)', () => {
  it('a copy of brand B’s file onto brand A’s record is refused in words, both ways, and nothing is stored', async () => {
    const before = await countFiles()
    const refused = await call('office', 'POST', `/files/${betaFile.id}/use-on`, { recordType: 'SalesOrder', recordId: SO1 })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error.issues).toEqual([{ path: 'refusal/OTHER_PARTY', message: USE_ON_WORDS.otherParty(BRAND_BETA.fileName) }])
    expect((await call('office', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'SalesOrder', recordId: second.salesOrderId, visibility: ['PARTNER'] })).body.error.issues[0].path).toBe('refusal/OTHER_PARTY')
    expect(await countFiles()).toBe(before)
  })

  it('onto a record of the same customer: a copy that names its source, kind and category kept, shared only with that customer', async () => {
    const made = await call('office', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'Quote', recordId: Q1, visibility: ['PARTNER'] })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.file).toMatchObject({ recordType: 'Quote', recordId: Q1, kind: 'DOCUMENT', originalName: BRAND_ALPHA.fileName, sha256: alphaFile.sha256, visibility: ['OFFICE', 'PARTNER'], partyId: P1, sourceFileId: alphaFile.id, status: 'AVAILABLE' })
    expect((await admin<{ category: string }>('SELECT category::text FROM "StoredFile" WHERE id = $1', [made.body.file.id]))[0]!.category).toBe('ARTWORK')
    // The quote's list says where the copy came from.
    const listed = (await call('office', 'GET', `/files?recordType=Quote&recordId=${Q1}`)).body.files.find((file: Json) => file.id === made.body.file.id)
    expect(listed.origin).toEqual({ fileId: alphaFile.id, recordType: 'SalesOrder', recordId: SO1, originalName: BRAND_ALPHA.fileName, versionNo: 1 })
  })

  it('onto a record of no customer it stays the office’s; our own file may go to any customer’s record', async () => {
    const internal = await call('office', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'Company', recordId: companyA })
    expect(internal.status, JSON.stringify(internal.body)).toBe(201)
    expect(internal.body.file).toMatchObject({ visibility: ['OFFICE'], partyId: null, sourceFileId: alphaFile.id })
    const ours = await call('office', 'POST', `/files/${ourFile.id}/use-on`, { recordType: 'SalesOrder', recordId: second.salesOrderId, visibility: ['PARTNER'] })
    expect(ours.status, JSON.stringify(ours.body)).toBe(201)
    expect(ours.body.file).toMatchObject({ partyId: second.partyId, visibility: ['OFFICE', 'PARTNER'] })
  })

  it('a person limited to brand A neither reads brand B’s file nor writes on brand B’s record; the same record, an owned record type and a reader are refused', async () => {
    expect((await call('alphaOnly', 'POST', `/files/${betaFile.id}/use-on`, { recordType: 'Company', recordId: companyA })).status).toBe(404)
    expect((await call('alphaOnly', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'SalesOrder', recordId: second.salesOrderId })).status).toBe(404)
    expect((await call('office', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'SalesOrder', recordId: SO1 })).body.error.issues[0]).toEqual({ path: 'body/recordId', message: USE_ON_WORDS.sameRecord })
    expect((await call('office', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'MeasurementProfile', recordId: newId() })).body.error.issues[0]).toEqual({ path: 'body/recordType', message: USE_ON_WORDS.ownedTarget })
    expect((await call('reader', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'Company', recordId: companyA })).status).toBe(403)
  })
})

// ---- B-TH-231 (threads plan TH-2, T9-F05; walls W25 / W26): the picker offers only the same customer's records or none ---------
describe('B-TH-231: "Use on another record…" offers records of the same customer or none', () => {
  it('brand A’s file: brand A’s quotes, never brand B’s order, never its own record', async () => {
    const answer = await call('picker', 'GET', `/files/${alphaFile.id}/use-on/targets?q=seed`)
    expect(answer.status, JSON.stringify(answer.body)).toBe(200)
    const ids = answer.body.targets.map((target: Json) => target.recordId)
    expect(ids).toContain(Q1)
    expect(ids).not.toContain(second.salesOrderId)
    expect(ids).not.toContain(SO1)
    for (const target of answer.body.targets) expect([P1, null]).toContain(target.partyId)
    expect(JSON.stringify(answer.body)).not.toContain('SEED-SO-B001')
  })

  it('our own file (no customer) may go to either brand’s records; too short a query looks nothing up', async () => {
    const ids = (await call('picker', 'GET', `/files/${ourFile.id}/use-on/targets?q=seed`)).body.targets.map((target: Json) => target.recordId)
    expect(ids).toEqual(expect.arrayContaining([second.salesOrderId, SO1, Q1]))
    expect((await call('picker', 'GET', `/files/${ourFile.id}/use-on/targets?q=s`)).body).toEqual({ tooShort: true, targets: [] })
  })

  it('brand B’s file is not found for a person limited to brand A', async () => {
    expect((await call('alphaOnly', 'GET', `/files/${betaFile.id}/use-on/targets?q=seed`)).status).toBe(404)
  })

  it('sharing the copy with the customer needs files.manage, as at upload', async () => {
    expect((await call('uploaderOnly', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'Quote', recordId: Q1, visibility: ['PARTNER'] })).status).toBe(403)
    expect((await call('uploaderOnly', 'POST', `/files/${alphaFile.id}/use-on`, { recordType: 'Quote', recordId: Q1 })).status).toBe(201)
  })
})
// ---- end B-TH-231
