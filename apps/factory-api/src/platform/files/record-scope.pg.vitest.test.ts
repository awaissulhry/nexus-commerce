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
import { startHarness, type Harness } from '../auth/sessions/testing/harness'

/**
 * B-PR-44 (the production lane's finding in B-TH-029's area; Decision 17: "a customer limit covers customer records"; Owner rule
 * 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit, should be
 * able to see it all"). A file of an order line or a quote line (a configured line's artwork) is read through its order or
 * quote: a person limited to customer B gets 404 on customer A's line file — by id, download, preview, versions, history — and
 * never sees it in the line's list, nor changes it (share, delete); customer A's own limited person opens it; the factory reads it
 * all. A line whose order is gone opens only for every-customer readers (fail closed); a type that names no customer keeps the
 * company check for everyone. Use on reads a line's customer through its order too.
 *
 * Two brands of one tenant: P1 (the seeds' customer, SEED-SO-0001 and its quote's lines: Brand Alpha) and the second brand of
 * factory-db's testing/second-brand.ts (SEED-SO-B001: Brand Beta). Run with `node scripts/factory/run-pg-tests.mjs platform/files/record-scope`.
 */

let h: Harness
let app: FastifyInstance
let second: SecondBrand
const NS = 'files-record-scope'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const WORK: Permission[] = ['files.read', 'files.upload', 'files.manage', 'files.delete']
const SESSIONS: Record<string, () => SessionContext> = {
  everyBrand: () => office(WORK),
  alphaOnly: () => office(WORK, [P1]),
  betaOnly: () => office(WORK, [second.partyId]),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `record-scope-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function uploaded(name: string, record: { recordType: string; recordId: string }): Promise<Json> {
  const body = Buffer.from(`%PDF-1.7 made-up line artwork of the record-scope test: ${name}`)
  const announced = await call('everyBrand', 'POST', '/files', { companyId: companyA, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...record })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await call('everyBrand', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}

const ORDER_LINE_FILE = 'Brand Alpha order line artwork (made up).pdf'
const QUOTE_LINE_FILE = 'Brand Alpha quote line logo (made up).pdf'
let orderLine: string
let quoteLine: string
let orderLineFile: Json
let quoteLineFile: Json
let orphanFile: Json
let plainFile: Json

beforeAll(async () => {
  h = await startHarness('files_record_scope')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  orderLine = (await admin<{ id: string }>('SELECT id::text FROM "SalesOrderLine" WHERE "tenantId" = $1 AND "orderId" = $2 ORDER BY id LIMIT 1', [T, SO1]))[0]!.id
  quoteLine = (await admin<{ id: string }>('SELECT ql.id::text FROM "QuoteLine" ql JOIN "QuoteVersion" qv ON qv.id = ql."versionId" JOIN "Quote" q ON q.id = qv."quoteId" WHERE ql."tenantId" = $1 AND q."partyId" = $2 ORDER BY ql.id LIMIT 1', [T, P1]))[0]!.id
  orderLineFile = await uploaded(ORDER_LINE_FILE, { recordType: 'SalesOrderLine', recordId: orderLine })
  quoteLineFile = await uploaded(QUOTE_LINE_FILE, { recordType: 'QuoteLine', recordId: quoteLine })
  // A line whose order is gone (its id names no line): the customer cannot be read.
  orphanFile = await uploaded('Orphan line artwork (made up).pdf', { recordType: 'SalesOrderLine', recordId: newId() })
  // A record type that names no customer: the company decides, as before.
  plainFile = await uploaded('Chemical safety sheet (made up).pdf', { recordType: 'Chemical', recordId: newId() })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-PR-44: an order line’s and a quote line’s file follow their order and quote (Decision 17)', () => {
  it('a person limited to customer B gets 404 on customer A’s line files by id, download, preview, versions and history, and lists none', async () => {
    for (const [file, line, type, name] of [
      [orderLineFile, orderLine, 'SalesOrderLine', ORDER_LINE_FILE],
      [quoteLineFile, quoteLine, 'QuoteLine', QUOTE_LINE_FILE],
    ] as const) {
      for (const url of [`/files/${file.id}`, `/files/${file.id}/download`, `/files/${file.id}/preview`, `/files/${file.id}/versions`, `/files/${file.id}/history`, `/files/${file.id}/markups`]) {
        const answer = await call('betaOnly', 'GET', url)
        expect(answer.status, `${type} ${url}: ${JSON.stringify(answer.body)}`).toBe(404)
        expect(JSON.stringify(answer.body)).not.toContain(name)
      }
      const list = await call('betaOnly', 'GET', `/files?recordType=${type}&recordId=${line}`)
      expect(list.body.files, type).toEqual([])
      expect(JSON.stringify(list.body)).not.toContain(name)
    }
  })

  it('nor changes them by id: share, delete, a new version, a tag', async () => {
    expect((await call('betaOnly', 'PUT', `/files/${orderLineFile.id}/visibility`, { visibility: ['OFFICE'], version: orderLineFile.version })).status).toBe(404)
    expect((await call('betaOnly', 'DELETE', `/files/${quoteLineFile.id}?version=${quoteLineFile.version}`)).status).toBe(404)
    expect((await call('betaOnly', 'POST', `/files/${orderLineFile.id}/versions`, { originalName: 'v2.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) })).status).toBe(404)
    expect((await call('betaOnly', 'PUT', `/files/${orderLineFile.id}/document`, { category: 'OTHER', version: orderLineFile.version })).status).toBe(404)
    expect((await admin('SELECT status::text FROM "StoredFile" WHERE id = $1', [quoteLineFile.id]))[0]).toEqual({ status: 'AVAILABLE' })
  })

  it('customer A’s own limited person opens them and lists them; the factory reads them all', async () => {
    for (const session of ['alphaOnly', 'everyBrand']) {
      for (const [file, line, type] of [
        [orderLineFile, orderLine, 'SalesOrderLine'],
        [quoteLineFile, quoteLine, 'QuoteLine'],
      ] as const) {
        expect((await call(session, 'GET', `/files/${file.id}`)).status, `${session} ${type}`).toBe(200)
        expect((await call(session, 'GET', `/files/${file.id}/download`)).status, `${session} ${type}`).toBe(200)
        expect((await call(session, 'GET', `/files?recordType=${type}&recordId=${line}`)).body.files.map((one: Json) => one.id), `${session} ${type}`).toContain(file.id)
      }
    }
  })

  it('a line whose order cannot be read opens only for every-customer readers (fail closed); a type of no customer keeps the company check', async () => {
    expect((await call('alphaOnly', 'GET', `/files/${orphanFile.id}`)).status).toBe(404)
    expect((await call('betaOnly', 'GET', `/files/${orphanFile.id}`)).status).toBe(404)
    expect((await call('everyBrand', 'GET', `/files/${orphanFile.id}`)).status).toBe(200)
    for (const session of ['alphaOnly', 'betaOnly', 'everyBrand']) expect((await call(session, 'GET', `/files/${plainFile.id}`)).status, session).toBe(200)
  })

  it('Use on reads a line’s customer through its order: customer A’s line artwork never goes onto customer B’s order', async () => {
    const refused = await call('everyBrand', 'POST', `/files/${orderLineFile.id}/use-on`, { recordType: 'SalesOrder', recordId: second.salesOrderId })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    expect(refused.body.error.issues[0].path).toBe('refusal/OTHER_PARTY')
    expect((await call('everyBrand', 'POST', `/files/${orderLineFile.id}/use-on`, { recordType: 'SalesOrder', recordId: SO1 })).status).toBe(201)
  })
})
