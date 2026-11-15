import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'

/**
 * The price list PDF kept for mail (B-W2b-380, XF6:01) through the app's real routes on a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security and the GeneratedDocument guard — PRICE_LIST of a PriceListVersion, its
 * file a file of the version — are real), every seed in tenant A. SEED-PL-P1 (company A): version 1 in force, version 2 a draft.
 * Company A's letterhead gets made-up registration numbers. Every name and address is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/pricelists/pdf-store`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'price-list-pdf-380'
const T = seedUuid(NS, 'tenant')
const COMPANY_A = seedUuid(NS, 'company:A')

function grantsOf(role: string, without: readonly string[] = []): Grant[] {
  const template = templateOf(role)!
  const permissions = [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)].filter((permission) => !without.includes(permission))
  return [{ permissions, companies: 'all', sites: 'all', parties: 'all' }]
}
const PEOPLE = { sales: newId(), noPrice: newId(), admin: newId() } as const
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `w2b380-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)

let listId = ''
let draftId = ''
let p1 = ''
const pdfUrl = () => `/sales/price-lists/${listId}/versions/${draftId}/pdf`

beforeAll(async () => {
  h = await startHarness('pl_pdf_w2b380')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const roles: Record<keyof typeof PEOPLE, Grant[]> = { sales: grantsOf('sales'), noPrice: grantsOf('sales', ['money.price']), admin: grantsOf('admin') }
  for (const [person, grants] of Object.entries(roles)) {
    const id = PEOPLE[person as keyof typeof PEOPLE]
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [id, T, `w2b380-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: id, grants }
  }
  // Company A's letterhead (c.c. art. 2250: the PDF prints it; made-up numbers).
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [COMPANY_A])
  const list = await one<{ id: string }>(`SELECT id FROM "PriceList" WHERE "tenantId" = $1 AND code = 'SEED-PL-P1'`, [T])
  listId = list.id
  p1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [T])).id
  draftId = (await one<{ id: string }>(`SELECT id FROM "PriceListVersion" WHERE "listId" = $1 AND status = 'DRAFT'`, [listId])).id
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-price-list-pdf-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await h?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the price list PDF kept for mail (XF6:01)', () => {
  it('none kept at first; keeping stores a PRICE_LIST document whose file is a file of the version', async () => {
    expect((await ok('sales', 'GET', pdfUrl())).pdf).toMatchObject({ versionId: draftId, upToDate: null, needsCompany: false, pdfs: [] })
    const kept = await ok('sales', 'POST', pdfUrl(), { language: 'en' })
    expect(kept).toMatchObject({ made: true, version: 1, pdf: { upToDate: true, pdfs: [{ version: 1, language: 'en', companyId: COMPANY_A, createdBy: 'Made-up sales' }] } })
    expect(kept.pdf.pdfs[0].number).toMatch(/^SEED-PL-P1 v2 · 1$/)
    const document = await one<Json>(`SELECT kind::text AS kind, "recordType", "recordId", "companyId", "siteId", "fileId" FROM "GeneratedDocument" WHERE id = $1`, [kept.pdf.pdfs[0].id])
    expect(document).toEqual({ kind: 'PRICE_LIST', recordType: 'PriceListVersion', recordId: draftId, companyId: COMPANY_A, siteId: null, fileId: kept.fileId })
    const file = await one<Json>(`SELECT "recordType", "recordId", "contentType", "originalName", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1`, [kept.fileId])
    expect(file).toMatchObject({ recordType: 'PriceListVersion', recordId: draftId, contentType: 'application/pdf', visibility: ['OFFICE'] })
    expect(file.originalName).toBe('price-list-seed-pl-p1-v2-1-en.pdf')
    expect(await outbox('price_list.pdf_kept')).toEqual([expect.objectContaining({ listId, versionId: draftId, revision: 2, pdfVersion: 1, fileId: kept.fileId })])
  })

  it('the same contents give the newest back; a changed draft is no longer up to date and keeps version 2', async () => {
    const again = await ok('sales', 'POST', pdfUrl(), { language: 'en' })
    expect(again).toMatchObject({ made: false, version: 1 })
    // Another language is another PDF.
    expect(await ok('sales', 'POST', pdfUrl(), { language: 'it' })).toMatchObject({ made: true, version: 2 })
    const draft = await one<{ version: number }>(`SELECT version FROM "PriceListVersion" WHERE id = $1`, [draftId])
    await ok('sales', 'PUT', `/sales/price-lists/${listId}/versions/${draftId}/size-surcharges`, { version: draft.version, surcharges: [{ styleId: null, size: '58', amount: '25', pct: null }] })
    expect((await ok('sales', 'GET', pdfUrl())).pdf).toMatchObject({ upToDate: false, pdfs: [{ version: 2 }, { version: 1 }] })
    expect(await ok('sales', 'POST', pdfUrl(), { language: 'it' })).toMatchObject({ made: true, version: 3, pdf: { upToDate: true } })
    expect(await admin(`SELECT version FROM "GeneratedDocument" WHERE "recordId" = $1 AND kind = 'PRICE_LIST' ORDER BY version`, [draftId])).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }])
  })

  it("the mail to a customer attaches a copy of that same file, on the customer's thread (the FAKE mail account)", async () => {
    const sent = await ok('sales', 'POST', `${pdfUrl()}/send`, { partyId: p1, to: ['buyer.list@example.com'], language: 'it' }, 201)
    expect(sent).toMatchObject({ version: 3, made: false })
    const kept = await one<{ fileId: string }>(`SELECT "fileId" FROM "GeneratedDocument" WHERE "recordId" = $1 AND kind = 'PRICE_LIST' AND version = 3`, [draftId])
    expect(sent.fileId).toBe(kept.fileId)
    const outbound = await one<Json>(`SELECT o.subject, o."recordType", o."recordId", o."to", m."attachmentFileIds" AS attachments FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o.id = $1`, [sent.outboundId])
    expect(outbound).toMatchObject({ recordType: 'Party', recordId: p1, to: ['buyer.list@example.com'], subject: 'Listino prezzi SEED-PL-P1 - Seed Customer One list' })
    expect(outbound.attachments).toEqual([sent.copyId])
    // The copy is the kept file's bytes on the customer: its source named, the same SHA-256, shared with that customer.
    const copy = await one<Json>(`SELECT c."recordType", c."recordId", c."partyId", c."sourceFileId", c.sha256 = s.sha256 AS same FROM "StoredFile" c JOIN "StoredFile" s ON s.id = c."sourceFileId" WHERE c.id = $1`, [sent.copyId])
    expect(copy).toEqual({ recordType: 'Party', recordId: p1, partyId: p1, sourceFileId: kept.fileId, same: true })
    expect(await outbox('price_list.pdf_sent')).toEqual([expect.objectContaining({ listId, versionId: draftId, pdfVersion: 3, partyId: p1, outboundId: sent.outboundId })])
  })

  it('refused in words: no price grain, no right to change it, no address, an incomplete letterhead', async () => {
    expect((await no('noPrice', 'GET', pdfUrl(), undefined, 403)).message).toBe("A price list's PDF holds its prices: your role does not see prices.")
    await no('admin', 'POST', pdfUrl(), {}, 403)
    await no('sales', 'POST', `${pdfUrl()}/send`, { partyId: p1, to: ['non-un-indirizzo'] }, 400)
    expect((await no('sales', 'POST', `${pdfUrl()}/send`, { partyId: COMPANY_A, to: ['buyer.list@example.com'] }, 400)).message).toBe('Not a customer of yours.')
    await admin(`UPDATE "Company" SET "reaNumber" = NULL WHERE id = $1`, [COMPANY_A])
    const refused = await no('sales', 'POST', pdfUrl(), { language: 'en' }, 409)
    expect(refused.message).toMatch(/REA|register/i)
    await admin(`UPDATE "Company" SET "reaNumber" = '0000001' WHERE id = $1`, [COMPANY_A])
  })
})
