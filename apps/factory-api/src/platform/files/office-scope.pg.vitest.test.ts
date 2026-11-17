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

/**
 * B-TH-029 (threads plan TH-2, WALL-G13, wall test T26; Owner rule 2026-11-16: "One brand must not be able to see anything
 * related to any other brand. But we, as the production unit, should be able to see it all"): an office file read checks its
 * record's own scope. An office person limited to brand A (RoleAssignment.partyIds) opens none of brand B's files — not by id,
 * not its download, preview or versions, not in the record's list (404 / empty, as a wrong id); a person without a limit reads
 * both brands' files as before; a person's own record (a User) asks its thread gate (users.view) too, as threads do.
 *
 * Two brands of one tenant: P1 (the seeds' customer and its order SEED-SO-0001, here Brand Alpha) and the second brand of
 * factory-db's testing/second-brand.ts (its order SEED-SO-B001, here Brand Beta). Run with
 * `node scripts/factory/run-pg-tests.mjs platform/files/office-scope`.
 */

let h: Harness
let app: FastifyInstance
let second: SecondBrand
const NS = 'files-office-scope'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
const colleague = newId()
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const office = (permissions: Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions, companies: 'all', sites: 'all', parties }] })
const SESSIONS: Record<string, () => SessionContext> = {
  everyBrand: () => office(['files.read', 'files.upload', 'files.manage']),
  alphaOnly: () => office(['files.read'], [P1]),
  betaOnly: () => office(['files.read'], [second.partyId]),
  people: () => office(['files.read', 'users.view']),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `office-scope-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up file of the office scope test: ${text}`)
async function uploaded(name: string, record: { recordType: string; recordId: string }): Promise<Json> {
  const body = pdf(name)
  const announced = await call('everyBrand', 'POST', '/files', { companyId: companyA, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...record })
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  expect((await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: body })).statusCode).toBe(200)
  const done = await call('everyBrand', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}

let alphaFile: Json
let betaFile: Json
let personFile: Json

beforeAll(async () => {
  h = await startHarness('files_office_scope')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, 'colleague.th029@example.com', 'Made-up colleague', 'ACTIVE')`, [colleague, T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  alphaFile = await uploaded(BRAND_ALPHA.fileName, { recordType: 'SalesOrder', recordId: SO1 })
  betaFile = await uploaded(BRAND_BETA.fileName, { recordType: 'SalesOrder', recordId: second.salesOrderId })
  personFile = await uploaded('Colleague training record.pdf', { recordType: 'User', recordId: colleague })
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('T26: a person limited to brand A opens brand B’s file by id: 404 (B-TH-029, WALL-G13)', () => {
  it('brand A’s person: brand B’s file is not found by id, download, preview or versions, and brand B’s order lists none', async () => {
    for (const url of [`/files/${betaFile.id}`, `/files/${betaFile.id}/download`, `/files/${betaFile.id}/preview`, `/files/${betaFile.id}/versions`]) {
      const answer = await call('alphaOnly', 'GET', url)
      expect(answer.status, `${url}: ${JSON.stringify(answer.body)}`).toBe(404)
      expect(JSON.stringify(answer.body)).not.toContain(BRAND_BETA.fileName)
    }
    expect((await call('alphaOnly', 'GET', `/files?recordType=SalesOrder&recordId=${second.salesOrderId}`)).body.files).toEqual([])
    // Its own brand's file opens.
    expect((await call('alphaOnly', 'GET', `/files/${alphaFile.id}`)).body.file).toMatchObject({ id: alphaFile.id })
    expect((await call('alphaOnly', 'GET', `/files?recordType=SalesOrder&recordId=${SO1}`)).body.files.map((file: Json) => file.id)).toContain(alphaFile.id)
  })

  it('the other way round, too', async () => {
    expect((await call('betaOnly', 'GET', `/files/${alphaFile.id}`)).status).toBe(404)
    expect((await call('betaOnly', 'GET', `/files?recordType=SalesOrder&recordId=${SO1}`)).body.files).toEqual([])
    expect((await call('betaOnly', 'GET', `/files/${betaFile.id}`)).status).toBe(200)
  })

  it('the factory sees it all: a person without a brand limit reads both brands’ files', async () => {
    for (const file of [alphaFile, betaFile]) expect((await call('everyBrand', 'GET', `/files/${file.id}`)).status).toBe(200)
  })

  it("a person's own record asks its thread gate as threads do: users.view", async () => {
    expect((await call('everyBrand', 'GET', `/files/${personFile.id}`)).status).toBe(404)
    expect((await call('everyBrand', 'GET', `/files?recordType=User&recordId=${colleague}`)).body.files).toEqual([])
    expect((await call('people', 'GET', `/files/${personFile.id}`)).status).toBe(200)
  })
})
