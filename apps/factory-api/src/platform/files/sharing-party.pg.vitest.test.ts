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
import { RECORD_PARTY_WORDS } from './files'

/**
 * B-TH-003 (threads plan TH-0, WALL-G02; T25 of the brand wall, Owner rule 2026-11-16: "one brand must not be able to see anything
 * related to any other brand"): a file is shared with a portal or a link only as its RECORD's own party — the one its thread
 * resolver names (platform/threads/records.ts) — never with one a request names. Through the routes: POST /files, PUT
 * /files/:id/visibility, a new version (POST /files/:id/versions) and a large upload (POST /files/uploads). Two brands of one
 * tenant: P1 (the seeds' customer, its order SEED-SO-0001) and the second brand of factory-db's testing/second-brand.ts (its order
 * SEED-SO-B001). Every name and address is made up. Run with `node scripts/factory/run-pg-tests.mjs sharing-party`.
 */

let h: Harness
let app: FastifyInstance
let second: SecondBrand
const NS = 'files-sharing-party'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SO1 = seedUuid(NS, 'sales:SO1')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const actor = newId()
const SESSIONS: Record<string, () => SessionContext> = {
  office: () => ({ audience: 'office', tenantId: T, actorId: actor, grants: [grant(['files.read', 'files.upload', 'files.manage'])] }),
}

async function call(method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': 'office', ...(method === 'GET' ? {} : { 'idempotency-key': `sharing-party-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up file of the sharing test: ${text}`)
const announce = (name: string, extra: Json) => {
  const body = pdf(name)
  return { companyId: companyA, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), ...extra }
}
/** A file of a record through the routes: announced, its bytes sent, confirmed. */
async function uploaded(name: string, extra: Json): Promise<Json> {
  const announced = await call('POST', '/files', announce(name, extra))
  expect(announced.status, JSON.stringify(announced.body)).toBe(201)
  const sent = await app.inject({ method: 'PUT', url: announced.body.upload.url, headers: announced.body.upload.headers, payload: pdf(name) })
  expect(sent.statusCode).toBe(200)
  const done = await call('POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, JSON.stringify(done.body)).toBe(200)
  return done.body.file
}
const refusedWith = (answer: { status: number; body: Json }, words: string) => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(400)
  expect(answer.body.error.issues).toEqual([{ path: 'body/partyId', message: words }])
}
const countFiles = async (): Promise<number> => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile" WHERE "tenantId" = $1', [T]))[0]!.n

beforeAll(async () => {
  h = await startHarness('files_sharing_party')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
  second = await seedSecondBrand({ db: h.database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-003 a file is shared only with its record’s party (T25)', () => {
  it('POST /files: brand A’s order file shared with the second brand is refused in words, nothing stored; with its own party it is shared; left out, the record’s party is taken', async () => {
    const before = await countFiles()
    refusedWith(await call('POST', '/files', announce('Brand A tech pack.pdf', { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER'], partyId: second.partyId })), RECORD_PARTY_WORDS.otherParty)
    refusedWith(await call('POST', '/files', announce('Brand A label.pdf', { recordType: 'SalesOrder', recordId: SO1, visibility: ['LINK'], partyId: second.partyId })), RECORD_PARTY_WORDS.otherParty)
    // The other way round: the second brand's order file is never shared with P1.
    refusedWith(await call('POST', '/files', announce('Second brand artwork.pdf', { recordType: 'SalesOrder', recordId: second.salesOrderId, visibility: ['PARTNER'], partyId: P1 })), RECORD_PARTY_WORDS.otherParty)
    // A record without a customer or supplier (the company), or one no thread resolver knows: never shared outside.
    refusedWith(await call('POST', '/files', announce('Company memo.pdf', { recordType: 'Company', recordId: companyA, visibility: ['PARTNER'], partyId: P1 })), RECORD_PARTY_WORDS.noParty)
    refusedWith(await call('POST', '/files', announce('Unknown record.pdf', { recordType: 'NoSuchRecord', recordId: newId(), visibility: ['LINK'], partyId: P1 })), RECORD_PARTY_WORDS.noParty)
    expect(await countFiles()).toBe(before)
    const own = await uploaded('Brand A care notes.pdf', { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER'], partyId: P1 })
    expect(own).toMatchObject({ visibility: ['OFFICE', 'PARTNER'], partyId: P1 })
    const taken = await uploaded('Brand A fit notes.pdf', { recordType: 'SalesOrder', recordId: second.salesOrderId, visibility: ['PARTNER', 'LINK'] })
    expect(taken).toMatchObject({ visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: second.partyId })
    // Office only and floor sharing are untouched: no party, none needed.
    expect(await uploaded('Office only.pdf', { recordType: 'Company', recordId: companyA })).toMatchObject({ visibility: ['OFFICE'], partyId: null })
  })

  it('PUT /files/:id/visibility: shared later only with the record’s party; another party refused in words and audited nowhere; the record’s party taken when left out', async () => {
    const file = await uploaded('Brand A size chart.pdf', { recordType: 'SalesOrder', recordId: SO1 })
    const other = await call('PUT', `/files/${file.id}/visibility`, { visibility: ['OFFICE', 'PARTNER'], partyId: second.partyId, version: file.version })
    refusedWith(other, RECORD_PARTY_WORDS.otherParty)
    expect((await admin('SELECT "partyId", visibility::text[] AS visibility FROM "StoredFile" WHERE id = $1', [file.id]))[0]).toEqual({ partyId: null, visibility: ['OFFICE'] })
    expect(await admin(`SELECT id FROM "AuditLog" WHERE "recordId" = $1 AND action = 'files.setVisibility'`, [file.id])).toEqual([])
    const shared = await call('PUT', `/files/${file.id}/visibility`, { visibility: ['OFFICE', 'LINK'], version: file.version })
    expect(shared.status, JSON.stringify(shared.body)).toBe(200)
    expect(shared.body.file).toMatchObject({ visibility: ['OFFICE', 'LINK'], partyId: P1 })
    const memo = await uploaded('Company plan.pdf', { recordType: 'Company', recordId: companyA })
    refusedWith(await call('PUT', `/files/${memo.id}/visibility`, { visibility: ['PARTNER'], partyId: P1, version: memo.version }), RECORD_PARTY_WORDS.noParty)
  })

  it('a new version and a large upload follow the same rule', async () => {
    const file = await uploaded('Brand A spec v1.pdf', { recordType: 'SalesOrder', recordId: SO1 })
    const { companyId: _company, kind: _kind, ...asVersion } = announce('Brand A spec v2.pdf', { visibility: ['PARTNER'], partyId: second.partyId })
    const version = await call('POST', `/files/${file.id}/versions`, asVersion)
    refusedWith(version, RECORD_PARTY_WORDS.otherParty)
    const large = await call('POST', '/files/uploads', { ...announce('Brand A video.pdf', { recordType: 'SalesOrder', recordId: SO1, visibility: ['PARTNER'], partyId: second.partyId }), sizeBytes: 12 * 1_048_576 })
    expect(large.status, JSON.stringify(large.body)).toBe(400)
    expect(large.body.error.issues).toContainEqual({ path: 'body/partyId', message: RECORD_PARTY_WORDS.otherParty })
  })
})
