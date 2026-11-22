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
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { MADE_WORDS } from './made'

/**
 * B-OF-010 … B-OF-015 (order files tab, PR S3.3; design order-files-2026-11-22 13-backend §3; Owner D4) — the acts on a whole document, on
 * the local stack with the app's real routes (a throwaway PostgreSQL 17 database from the migrations; the runtime login: row-level
 * security and the files guards are real; the local file store):
 *
 *   - POST /files/:id/delete-document: three versions deleted in ONE command, one audit row each with the reason, file.removed with every
 *     id; refused WHOLE when one version is on legal hold (none deleted), for a paper Nexus made (a generated document), a reason
 *     too short; DELETE /files/:id refuses a made paper too
 *   - POST /files/:id/rename: the current version copied as the next one under the new name (v4), the old one superseded, its name kept
 *     there; refused for an earlier version, the same name, a made paper
 *   - POST /files/:id/priced: taking the mark off a document born priced by its kind (a proforma) is refused; marking a file priced
 *     takes the floor off every copy it reaches (FLOOR and its site gone)
 *   - PUT /files/:id/visibility emits file.visibility_changed (no name)
 *
 * Every name and number is made up. Not run in the build (Owner rule: checks at the end). Run with
 * `node scripts/factory/run-pg-tests.mjs platform/files/documents`.
 */

let h: Harness
let app: FastifyInstance
const NS = 'of010-documents'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const siteA = seedUuid(NS, 'site:A1')
const SO1 = seedUuid(NS, 'sales:SO1')
type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
let counter = 0
const FILES: Permission[] = ['files.read', 'files.upload', 'files.manage', 'files.delete', 'threads.read', 'threads.post']
const office = (permissions: readonly Permission[], parties: Grant['parties'] = 'all'): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [{ permissions: [...permissions], companies: 'all', sites: 'all', parties }] })
const SESSIONS: Record<string, () => SessionContext> = {
  // The Owner: every file right and the price grain.
  owner: () => office([...FILES, 'money.price']),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `of010-${++counter}-${newId()}` }) }, ...(body === undefined ? {} : { payload: body as object }) })
  const json = response.headers['content-type']?.toString().startsWith('application/json') ? (response.json() as Json) : {}
  return { status: response.statusCode, body: json, raw: response.body }
}
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up document of the documents test: ${text}`)
const sha = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
async function put(upload: Json, body: Buffer): Promise<void> {
  expect((await app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })).statusCode).toBe(200)
}
/** A PDF of Brand Alpha's order, uploaded and confirmed by the Owner. */
async function uploaded(name: string, input: Json = {}): Promise<Json> {
  const body = pdf(`${name} ${newId()}`)
  const announced = await call('owner', 'POST', '/files', { companyId: companyA, kind: 'DOCUMENT', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body), originalName: name, recordType: 'SalesOrder', recordId: SO1, ...input })
  expect(announced.status, announced.raw).toBe(201)
  await put(announced.body.upload, body)
  const done = await call('owner', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, done.raw).toBe(200)
  return done.body.file
}
/** The next version of a file's series, uploaded and confirmed. */
async function nextVersion(fileId: string, name: string): Promise<Json> {
  const body = pdf(`${name} ${newId()}`)
  const announced = await call('owner', 'POST', `/files/${fileId}/versions`, { originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) })
  expect(announced.status, announced.raw).toBe(201)
  await put(announced.body.upload, body)
  const done = await call('owner', 'POST', `/files/${announced.body.file.id}/complete`)
  expect(done.status, done.raw).toBe(200)
  return done.body.file
}
/** v1, v2, v3 of one document. */
async function threeVersions(name: string): Promise<Json[]> {
  const v1 = await uploaded(`${name} v1.pdf`)
  const v2 = await nextVersion(v1.id, `${name} v2.pdf`)
  const v3 = await nextVersion(v2.id, `${name} v3.pdf`)
  return [v1, v2, v3]
}
const rowOf = async (fileId: string) => (await admin<Json>(`SELECT status::text AS status, version, "versionNo", "originalName", "supersededAt", priced, visibility::text[] AS visibility, "floorSiteId", "seriesId" FROM "StoredFile" WHERE id = $1`, [fileId]))[0]!
/** The owner, triggers off, for one statement (set-up only). */
async function plant(sql: string, values: unknown[]): Promise<void> {
  await admin('BEGIN')
  try {
    await admin("SET LOCAL session_replication_role = 'replica'")
    await admin(sql, values)
    await admin('COMMIT')
  } catch (error) {
    await admin('ROLLBACK')
    throw error
  }
}
/** A generated document of the order naming `fileId` (a paper Nexus made). */
const generated = (fileId: string, kind: string) =>
  plant(`INSERT INTO "GeneratedDocument" (id, "tenantId", "companyId", "recordType", "recordId", kind, version, fingerprint, language, "fileId") VALUES ($1, $2, $3, 'SalesOrder', $4, $5::"GeneratedDocumentKind", $6, 'made-up', 'it', $7)`, [newId(), T, companyA, SO1, kind, ++counter, fileId])

beforeAll(async () => {
  h = await startHarness('of010_documents')
  h.clock.set(new Date())
  for (const seed of [seedCore, seedNumbering, seedParties, seedFiles, seedProduct, seedSales]) await seed({ db: h.database, namespace: NS })
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

describe('B-OF-010 delete a whole document', () => {
  it('three versions deleted in one command, one audit row each with the reason, file.removed naming every id', async () => {
    const [v1, v2, v3] = await threeVersions('T-OF010 cutting plan')
    const answer = await call('owner', 'POST', `/files/${v3!.id}/delete-document`, { version: (await rowOf(v3!.id)).version, reason: 'Made-up: the wrong customer’s plan.' })
    expect(answer.status, answer.raw).toBe(200)
    expect(answer.body.removed).toBe(3)
    for (const file of [v1!, v2!, v3!]) expect((await rowOf(file.id)).status).toBe('DELETED')
    const audits = await admin<Json>(`SELECT "recordId", reason FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'files.deleteDocument' AND "recordId" = ANY($2::uuid[])`, [T, [v1!.id, v2!.id, v3!.id]])
    expect(audits.map((row) => row.recordId).sort()).toEqual([v1!.id, v2!.id, v3!.id].sort())
    expect(new Set(audits.map((row) => row.reason))).toEqual(new Set(['Made-up: the wrong customer’s plan.']))
    const [event] = await admin<Json>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'file.removed' AND payload->>'fileId' = $2`, [T, v3!.id])
    expect(event!.payload).toMatchObject({ recordType: 'SalesOrder', recordId: SO1 })
    expect([...event!.payload.fileIds].sort()).toEqual([v1!.id, v2!.id, v3!.id].sort())
    expect(JSON.stringify(event!.payload)).not.toContain('cutting plan')
  })

  it('refused WHOLE when one version is on legal hold: none deleted', async () => {
    const [v1, v2] = await threeVersions('T-OF010 held plan')
    const held = await call('owner', 'PUT', `/files/${v1!.id}/retention`, { legalHold: true, reason: 'Made-up: a claim is open.', version: (await rowOf(v1!.id)).version })
    expect(held.status, held.raw).toBe(200)
    const v3 = (await admin<Json>(`SELECT id, version FROM "StoredFile" WHERE "seriesId" = $1 AND "versionNo" = 3`, [v1!.id]))[0]!
    const refused = await call('owner', 'POST', `/files/${v3.id}/delete-document`, { version: v3.version, reason: 'Made-up: not needed.' })
    expect(refused.status, refused.raw).toBe(409)
    for (const id of [v1!.id, v2!.id, v3.id]) expect((await rowOf(id)).status).not.toBe('DELETED')
  })

  it('a paper Nexus made is never removed (delete-document and DELETE); a reason of 3 characters at least', async () => {
    const confirmation = await uploaded('T-OF012 order confirmation.pdf')
    await generated(confirmation.id, 'ORDER_CONFIRMATION')
    const version = (await rowOf(confirmation.id)).version
    const whole = await call('owner', 'POST', `/files/${confirmation.id}/delete-document`, { version, reason: 'Made-up: not needed.' })
    expect([whole.status, whole.body.error?.message]).toEqual([409, MADE_WORDS.delete])
    const one = await call('owner', 'DELETE', `/files/${confirmation.id}?version=${version}&reason=Made-up%20reason`)
    expect([one.status, one.body.error?.message]).toEqual([409, MADE_WORDS.delete])
    const plain = await uploaded('T-OF010 note.pdf')
    expect((await call('owner', 'POST', `/files/${plain.id}/delete-document`, { version: (await rowOf(plain.id)).version, reason: 'no' })).status).toBe(400)
  })
})

describe('B-OF-011 rename: the current version copied as the next one under the new name', () => {
  it('v4 carries the new name, v3 is superseded and keeps its own', async () => {
    const [, , v3] = await threeVersions('T-OF011 size chart')
    const answer = await call('owner', 'POST', `/files/${v3!.id}/rename`, { version: (await rowOf(v3!.id)).version, name: 'T-OF011 size chart final.pdf' })
    expect(answer.status, answer.raw).toBe(201)
    expect(answer.body.file).toMatchObject({ originalName: 'T-OF011 size chart final.pdf', versionNo: 4, status: 'AVAILABLE' })
    const old = await rowOf(v3!.id)
    expect(old.originalName).toBe('T-OF011 size chart v3.pdf')
    expect(old.supersededAt).not.toBeNull()
    // An earlier version, the same name, a paper Nexus made: refused.
    expect((await call('owner', 'POST', `/files/${v3!.id}/rename`, { version: old.version, name: 'T-OF011 other.pdf' })).status).toBe(409)
    expect((await call('owner', 'POST', `/files/${answer.body.file.id}/rename`, { version: (await rowOf(answer.body.file.id)).version, name: 'T-OF011 size chart final.pdf' })).status).toBe(400)
    const proforma = await uploaded('T-OF012 proforma.pdf')
    await generated(proforma.id, 'PROFORMA')
    const made = await call('owner', 'POST', `/files/${proforma.id}/rename`, { version: (await rowOf(proforma.id)).version, name: 'T-OF012 proforma renamed.pdf' })
    expect([made.status, made.body.error?.message]).toEqual([409, MADE_WORDS.rename])
  })
})

describe('B-OF-012 / B-OF-013 the price mark', () => {
  it('a document born priced by its kind (a proforma) never loses the mark', async () => {
    const proforma = await uploaded('T-OF012 proforma two.pdf', { priced: true })
    await generated(proforma.id, 'PROFORMA')
    const answer = await call('owner', 'POST', `/files/${proforma.id}/priced`, { priced: false, version: (await rowOf(proforma.id)).version })
    expect([answer.status, answer.body.error?.message]).toEqual([409, MADE_WORDS.unmark])
    expect((await rowOf(proforma.id)).priced).toBe(true)
  })

  it('marking a file priced takes the floor off a copy shared with a plant', async () => {
    const sheet = await uploaded('T-OF013 cost sheet.pdf')
    const copy = newId()
    await plant(
      `INSERT INTO "StoredFile" SELECT * FROM jsonb_populate_record(NULL::"StoredFile", (SELECT to_jsonb(f) || $1::jsonb FROM "StoredFile" f WHERE f.id = $2::uuid))`,
      [JSON.stringify({ id: copy, recordType: 'Site', recordId: siteA, sourceFileId: sheet.id, visibility: ['OFFICE', 'FLOOR'], floorSiteId: siteA, partyId: null, seriesId: null, storageKey: `t/${T}/c/${companyA}/2026/${newId()}` }), sheet.id],
    )
    const marked = await call('owner', 'POST', `/files/${sheet.id}/priced`, { priced: true, version: (await rowOf(sheet.id)).version })
    expect(marked.status, marked.raw).toBe(200)
    expect(await rowOf(copy)).toMatchObject({ priced: true, visibility: ['OFFICE'], floorSiteId: null })
  })
})

describe('B-OF-015 a share changed is told', () => {
  it('PUT /files/:id/visibility emits file.visibility_changed with the audiences, no name', async () => {
    const file = await uploaded('T-OF015 artwork.pdf')
    const shared = await call('owner', 'PUT', `/files/${file.id}/visibility`, { visibility: ['OFFICE', 'PARTNER'], version: (await rowOf(file.id)).version })
    expect(shared.status, shared.raw).toBe(200)
    const [event] = await admin<Json>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'file.visibility_changed' AND payload->>'fileId' = $2`, [T, file.id])
    expect(event!.payload).toMatchObject({ recordType: 'SalesOrder', recordId: SO1, audiences: ['OFFICE', 'PARTNER'] })
    expect(JSON.stringify(event!.payload)).not.toContain('artwork')
  })
})
