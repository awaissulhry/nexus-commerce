import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { localFileStore } from '../../adapters/local-files/local'
import { r2FileStore } from '../../adapters/r2/r2'
import { FakeR2 } from '../../adapters/r2/testing'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createGateway } from '../gateway/gateway'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../secrets/store'
import { createFilesRuntime, useFiles } from './service'

/**
 * Files on R2 on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login through the scoped clients, so row-level security and the guard trigger are real), the gateway
 * on the local Redis under this file's own prefix, the local store on a temporary folder (the FAKE account), and a
 * fake R2 (the real S3 client on an in-memory transport) for a LIVE account. Nothing here reaches a network service.
 * Run with `node scripts/factory/run-pg-tests.mjs files`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
const r2 = new FakeR2()

const tenantA = newId()
const tenantB = newId()
const companyOne = newId()
const companyTwo = newId()
const companyB = newId()
const siteOne = newId()
const siteTwo = newId()
const siteB = newId()
const partyOne = newId()
const partyTwo = newId()
const user = newId()
const quote = newId()
const otherQuote = newId()
const fakeStore = newId()
const fakeStoreB = newId()
let liveStore: string
const R2_SECRET = 'made-up-r2-secret-access-key-7c1e'

const ALL = ['files.read', 'files.upload', 'files.delete', 'files.manage'] as const
const grant = (permissions: Grant['permissions'], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const read = [grant(['files.read'])]
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL)] },
  'admin-one': { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL, [companyOne])] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: read },
  uploader: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['files.read', 'files.upload'])] },
  'admin-b': { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(ALL)] },
  'floor-one': { audience: 'floor', tenantId: tenantA, actorId: user, siteId: siteOne, deviceId: newId(), grants: [grant(ALL)] },
  'floor-two': { audience: 'floor', tenantId: tenantA, actorId: user, siteId: siteTwo, deviceId: newId(), grants: read },
  'partner-one': { audience: 'partner', tenantId: tenantA, actorId: user, partyId: partyOne, grants: read },
  'partner-two': { audience: 'partner', tenantId: tenantA, actorId: user, partyId: partyTwo, grants: read },
  'link-one': { audience: 'link', tenantId: tenantA, linkId: newId(), partyId: partyOne, record: { type: 'Quote', id: quote }, grants: read },
}

type File = { id: string; status: string; version: number; visibility: string[]; legalHold?: boolean; partyId?: string | null; floorSiteId?: string | null; retainUntil: string | null; quarantineReason: string | null }
type Presigned = { method: string; url: string; headers: Record<string, string>; expiresAt: string }

const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string | undefined, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: session ? { 'x-test-session': session } : {}, ...(payload === undefined ? {} : { payload: payload as object }) })
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up test file: ${text}`)
const announcement = (body: Buffer, fields: Record<string, unknown> = {}) => ({
  companyId: companyOne,
  recordType: 'Quote',
  recordId: quote,
  kind: 'DOCUMENT',
  originalName: 'Offer.pdf',
  contentType: 'application/pdf',
  sizeBytes: body.length,
  sha256: sha256(body),
  ...fields,
})
const keyOf = async (fileId: string): Promise<string> => (await admin<{ storageKey: string }>('SELECT "storageKey" FROM "StoredFile" WHERE id = $1', [fileId]))[0]!.storageKey
const callsOf = (accountId: string) => admin('SELECT operation, status, mode, reason, "requestSummary", "responseSummary" FROM "IntegrationCall" WHERE "accountId" = $1 ORDER BY "startedAt", id', [accountId])

async function announce(body: Buffer, fields: Record<string, unknown> = {}, session = 'admin'): Promise<{ file: File; upload: Presigned }> {
  const response = await call(session, 'POST', '/files', announcement(body, fields))
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
const send = (upload: Presigned, body: Buffer) => app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })

/** Announce, send to the local store, confirm: an AVAILABLE file. */
async function uploaded(text: string, fields: Record<string, unknown> = {}): Promise<File> {
  const body = pdf(text)
  const { file, upload } = await announce(body, fields)
  const sent = await send(upload, body)
  expect(sent.statusCode, sent.body).toBe(200)
  const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return confirmed.json().file
}
const download = async (session: string, fileId: string) => {
  const response = await call(session, 'GET', `/files/${fileId}/download`)
  return { status: response.statusCode, download: response.statusCode === 200 ? (response.json().download as Presigned) : null }
}
const list = async (session: string, recordId = quote) => {
  const response = await call(session, 'GET', `/files?recordType=Quote&recordId=${recordId}`)
  expect(response.statusCode, response.body).toBe(200)
  return (response.json().files as File[]).map((file) => file.id)
}

beforeAll(async () => {
  db = await migratedDatabase('files')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-files-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  for (const [tenantId, slug, companies, sites, store] of [
    [tenantA, 'files-a', [companyOne, companyTwo], [siteOne, siteTwo], fakeStore],
    [tenantB, 'files-b', [companyB], [siteB], fakeStoreB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, companyId] of companies.entries()) {
      await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-${index}`])
    }
    for (const [index, siteId] of sites.entries()) {
      await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, $4, $4, 'PLANT')`, [siteId, tenantId, companies[0], `${slug}-s${index}`])
    }
    // The tenant's file store: FAKE (the local folder), with room for every call of this file in its rate limit.
    await admin(
      `INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`,
      [store, tenantId],
    )
  }
  // Company two keeps its files on "R2" (LIVE, the fake transport), its credentials sealed like the admin step will.
  liveStore = newId()
  const office = callerFor(database, { audience: 'office', tenantId: tenantA, actorId: user, grants: [], requestId: newId() })
  await command(office, { name: 'integration.createAccount', input: { liveStore } }, async (tools) => {
    const secret = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.credentials, plaintext: JSON.stringify({ accessKeyId: 'made-up-access-key-id', secretAccessKey: R2_SECRET }) })
    await tools.tx.integrationAccount.create({
      data: {
        id: liveStore,
        companyId: companyTwo,
        provider: 'R2',
        code: 'files-two',
        label: 'Files of company two',
        mode: 'LIVE',
        credentialsSecretId: secret.id,
        settings: { endpoint: 'https://example-account.eu.r2.cloudflarestorage.com', bucket: 'factory-test', legalBucket: 'factory-test-legal' },
        rateLimitPerMinute: 6000,
        rateLimitBurst: 1000,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: liveStore })
    return { id: liveStore }
  })

  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }), r2: r2FileStore({ clientFor: r2.clientFor }) }))
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

describe('upload → confirm → download (COL-045)', () => {
  it('round-trips a file through the local store, audited, with its event and one ledger row per store call', async () => {
    const body = pdf('round trip')
    const { file, upload } = await announce(body)
    expect(file).toMatchObject({ status: 'PENDING_UPLOAD', visibility: ['OFFICE'], version: 1, legalHold: false, sizeBytes: body.length, sha256: sha256(body), retainUntil: null })
    expect(upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/pdf' } })
    expect(upload.url).toMatch(/^\/local-files\?token=[\w-]+\.[\w-]+$/)
    expect(Date.parse(upload.expiresAt) - Date.now()).toBeGreaterThan(290_000)
    expect(await keyOf(file.id)).toMatch(new RegExp(`^t/${tenantA}/c/${companyOne}/\\d{4}/[0-9a-f-]{36}$`))
    expect(JSON.stringify(file)).not.toMatch(/storageKey|storeAccountId|local-files/)

    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(409)
    const stored = await send(upload, body)
    expect(stored.statusCode, stored.body).toBe(200)
    expect(stored.json()).toEqual({ status: 'stored' })
    const confirmed = (await call('admin', 'POST', `/files/${file.id}/complete`)).json().file as File & { availableAt: string }
    expect(confirmed).toMatchObject({ status: 'AVAILABLE', version: 2 })
    expect(confirmed.availableAt).not.toBeNull()
    // Confirming again changes nothing.
    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).json().file).toMatchObject({ status: 'AVAILABLE', version: 2 })

    const { status, download: get } = await download('admin', file.id)
    expect(status).toBe(200)
    expect(get).toMatchObject({ method: 'GET', headers: {} })
    expect(Date.parse(get!.expiresAt) - Date.now()).toBeLessThanOrEqual(60_000)
    const fetched = await app.inject({ method: 'GET', url: get!.url })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.rawPayload.equals(body)).toBe(true)
    expect(fetched.headers['content-type']).toMatch(/^application\/pdf/)
    expect(fetched.headers['content-disposition']).toBe(`attachment; filename="Offer.pdf"; filename*=UTF-8''Offer.pdf`)

    expect((await call('admin', 'GET', `/files/${file.id}`)).json().file).toMatchObject({ id: file.id, status: 'AVAILABLE' })
    expect(await list('admin')).toContain(file.id)
    const audits = await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id`, [file.id])
    expect(audits.map((row) => row.action)).toEqual(['files.requestUpload', 'files.completeUpload'])
    const events = await admin(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1`, [file.id])
    expect(events).toEqual([{ type: 'file.available', payload: { fileId: file.id, recordType: 'Quote', recordId: quote, kind: 'DOCUMENT' } }])
    const key = await keyOf(file.id)
    expect((await callsOf(fakeStore)).filter((row) => (row.requestSummary as { key?: string } | null)?.key === key).map((row) => [row.operation, row.status, row.mode])).toEqual([
      ['files.presign_upload', 'SUCCEEDED', 'FAKE'],
      // The confirmation sent before the upload: the store had nothing yet.
      ['files.head', 'SUCCEEDED', 'FAKE'],
      ['files.head', 'SUCCEEDED', 'FAKE'],
      ['files.presign_download', 'SUCCEEDED', 'FAKE'],
    ])
    expect(JSON.stringify(await admin('SELECT * FROM "IntegrationCall"'))).not.toContain('Offer.pdf')
  })

  it('refuses a type or size the kind does not allow, an inconsistent sharing and a short fiscal retention, storing nothing', async () => {
    const count = async () => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "StoredFile"'))[0]!.n
    const before = await count()
    const body = pdf('refused')
    const refusals: [Record<string, unknown>, string][] = [
      [{ contentType: 'text/html' }, 'body/contentType'],
      [{ kind: 'PHOTO', contentType: 'image/svg+xml' }, 'body/contentType'],
      [{ kind: 'PHOTO', contentType: 'image/jpeg', sizeBytes: 15 * 1_048_576 + 1 }, 'body/sizeBytes'],
      [{ sha256: 'not-a-checksum' }, 'body/sha256'],
      [{ originalName: '../' }, 'body/originalName'],
      [{ visibility: ['FLOOR'] }, 'body/floorSiteId'],
      [{ visibility: ['PARTNER'] }, 'body/partyId'],
      [{ partyId: partyOne }, 'body/partyId'],
      [{ companyId: null, visibility: ['FLOOR'], floorSiteId: siteOne }, 'body/companyId'],
      [{ kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', retainUntil: '2030-01-01T00:00:00.000Z' }, 'body/retainUntil'],
      [{ visibility: ['FLOOR'], floorSiteId: siteB }, 'body/floorSiteId'],
    ]
    for (const [fields, path] of refusals) {
      const response = await call('admin', 'POST', '/files', announcement(body, fields))
      expect(response.statusCode, JSON.stringify(fields)).toBe(400)
      expect(response.json().error.issues.map((issue: { path: string }) => issue.path), JSON.stringify(fields)).toContain(path)
    }
    expect((await call('admin', 'POST', '/files', announcement(body, { kind: 'INVOICE' }))).statusCode).toBe(400)
    expect(await count()).toBe(before)
  })

  it('refuses a body that is not the one announced, and quarantines an upload the store holds differently', async () => {
    const body = pdf('announced')
    const { file, upload } = await announce(body)
    expect((await send(upload, pdf('something else'))).statusCode).toBe(400)
    expect((await send({ ...upload, headers: { 'content-type': 'image/png' } }, body)).statusCode).toBe(400)
    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(409)
    expect((await send(upload, body)).statusCode).toBe(200)
    // The store now holds other bytes under the key (as if the object were replaced): the confirmation catches it.
    writeFileSync(join(localRoot, await keyOf(file.id)), pdf('replaced!'))
    const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
    expect(confirmed.json().file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'checksum_mismatch' })
    expect((await download('admin', file.id)).status).toBe(409)
    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(409)
    expect(await list('admin')).toContain(file.id)
  })
})

describe('who sees a file (COL-050)', () => {
  it('a floor device sees only the files shared with its own site\'s floor', async () => {
    const internal = await uploaded('internal')
    const floorOne = await uploaded('floor one', { visibility: ['FLOOR'], floorSiteId: siteOne })
    const floorTwo = await uploaded('floor two', { visibility: ['FLOOR'], floorSiteId: siteTwo })
    expect(floorOne).toMatchObject({ visibility: ['OFFICE', 'FLOOR'], floorSiteId: siteOne })

    for (const fileId of [internal.id, floorTwo.id]) {
      expect((await call('floor-one', 'GET', `/files/${fileId}`)).statusCode).toBe(404)
      expect((await download('floor-one', fileId)).status).toBe(404)
    }
    const seen = (await call('floor-one', 'GET', `/files/${floorOne.id}`)).json().file as File
    expect(seen).toMatchObject({ id: floorOne.id, floorSiteId: siteOne })
    expect(seen).not.toHaveProperty('legalHold')
    expect(seen).not.toHaveProperty('partyId')
    const { status, download: get } = await download('floor-one', floorOne.id)
    expect(status).toBe(200)
    expect((await app.inject({ method: 'GET', url: get!.url })).rawPayload.equals(pdf('floor one'))).toBe(true)
    expect(await list('floor-one')).toEqual([floorOne.id])
    expect(await list('floor-two')).toEqual([floorTwo.id])
    // The floor's download was presigned as its tenant's system (the gateway calls for office and system only).
    const key = await keyOf(floorOne.id)
    expect((await callsOf(fakeStore)).filter((row) => (row.requestSummary as { key?: string } | null)?.key === key).map((row) => row.operation)).toContain('files.presign_download')
    // A floor device never writes files.
    expect((await call('floor-one', 'POST', '/files', announcement(pdf('x')))).statusCode).toBe(403)
  })

  it('a portal sees only its party\'s portal files; a link only its party\'s link files of its own record', async () => {
    const portalOne = await uploaded('portal one', { visibility: ['PARTNER'], partyId: partyOne })
    const portalTwo = await uploaded('portal two', { visibility: ['PARTNER'], partyId: partyTwo })
    const linkOne = await uploaded('link one', { visibility: ['LINK'], partyId: partyOne })
    const linkElsewhere = await uploaded('link elsewhere', { visibility: ['LINK'], partyId: partyOne, recordId: otherQuote })
    const both = await uploaded('both', { visibility: ['PARTNER', 'LINK'], partyId: partyOne })

    const seen = (await call('partner-one', 'GET', `/files/${portalOne.id}`)).json().file as File
    expect(seen).toMatchObject({ id: portalOne.id, partyId: partyOne })
    for (const hidden of ['legalHold', 'floorSiteId']) expect(seen).not.toHaveProperty(hidden)
    expect((await download('partner-one', portalOne.id)).status).toBe(200)
    for (const fileId of [portalTwo.id, linkOne.id]) expect((await call('partner-one', 'GET', `/files/${fileId}`)).statusCode).toBe(404)
    expect((await list('partner-one')).sort()).toEqual([portalOne.id, both.id].sort())
    expect(await list('partner-two')).toEqual([portalTwo.id])

    expect((await call('link-one', 'GET', `/files/${linkOne.id}`)).statusCode).toBe(200)
    const { status, download: get } = await download('link-one', linkOne.id)
    expect(status).toBe(200)
    expect((await app.inject({ method: 'GET', url: get!.url })).rawPayload.equals(pdf('link one'))).toBe(true)
    for (const fileId of [portalOne.id, linkElsewhere.id, portalTwo.id]) expect((await call('link-one', 'GET', `/files/${fileId}`)).statusCode).toBe(404)
    expect((await list('link-one')).sort()).toEqual([linkOne.id, both.id].sort())
    expect(await list('link-one', otherQuote)).toEqual([])
  })

  it('shares a file later (files.manage), audited, with a stale version refused', async () => {
    const file = await uploaded('shared later')
    expect((await call('floor-one', 'GET', `/files/${file.id}`)).statusCode).toBe(404)
    const shared = await call('admin', 'PUT', `/files/${file.id}/visibility`, { visibility: ['FLOOR', 'PARTNER'], floorSiteId: siteOne, partyId: partyTwo, version: file.version })
    expect(shared.statusCode, shared.body).toBe(200)
    expect(shared.json().file).toMatchObject({ visibility: ['OFFICE', 'FLOOR', 'PARTNER'], floorSiteId: siteOne, partyId: partyTwo, version: file.version + 1 })
    expect((await call('floor-one', 'GET', `/files/${file.id}`)).statusCode).toBe(200)
    expect((await call('partner-two', 'GET', `/files/${file.id}`)).statusCode).toBe(200)
    expect((await call('admin', 'PUT', `/files/${file.id}/visibility`, { visibility: [], version: file.version })).statusCode).toBe(409)
    expect((await call('admin', 'PUT', `/files/${file.id}/visibility`, { visibility: ['FLOOR'], version: file.version + 1 })).statusCode).toBe(400)
    expect((await call('viewer', 'PUT', `/files/${file.id}/visibility`, { visibility: [], version: file.version + 1 })).statusCode).toBe(403)
    const unshared = await call('admin', 'PUT', `/files/${file.id}/visibility`, { visibility: [], version: file.version + 1 })
    expect(unshared.json().file).toMatchObject({ visibility: ['OFFICE'], floorSiteId: null, partyId: null })
    expect((await call('floor-one', 'GET', `/files/${file.id}`)).statusCode).toBe(404)
    const [audit] = await admin(`SELECT before, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'files.setVisibility' ORDER BY at, id LIMIT 1`, [file.id])
    expect(audit).toEqual({ before: { visibility: ['OFFICE'], floorSiteId: null, partyId: null }, after: { visibility: ['OFFICE', 'FLOOR', 'PARTNER'], floorSiteId: siteOne, partyId: partyTwo } })
  })

  it('keeps writes and reads to the caller\'s permission, companies and tenant', async () => {
    const one = await uploaded('company one')
    const body = pdf('company two')
    expect((await call('viewer', 'POST', '/files', announcement(body))).statusCode).toBe(403)
    // Uploading is files.upload; sharing beyond the office, at upload too, is files.manage.
    expect((await call('uploader', 'POST', '/files', announcement(body))).statusCode).toBe(201)
    expect((await call('uploader', 'POST', '/files', announcement(body, { visibility: ['PARTNER'], partyId: partyOne }))).statusCode).toBe(403)
    expect((await call('uploader', 'POST', '/files', announcement(body, { visibility: ['FLOOR'], floorSiteId: siteOne }))).statusCode).toBe(403)
    expect((await call('admin-one', 'POST', '/files', announcement(body, { companyId: companyTwo }))).statusCode).toBe(403)
    expect((await call(undefined, 'POST', '/files', announcement(body))).statusCode).toBe(401)
    expect((await call(undefined, 'GET', `/files/${one.id}`)).statusCode).toBe(401)
    expect((await call('viewer', 'GET', `/files/${one.id}`)).statusCode).toBe(200)
    expect((await call('viewer', 'DELETE', `/files/${one.id}`)).statusCode).toBe(403)
    // Tenant B: its own store, and nothing of tenant A's.
    const other = await call('admin-b', 'POST', '/files', announcement(body, { companyId: companyB }))
    expect(other.statusCode, other.body).toBe(201)
    expect(await keyOf(other.json().file.id)).toMatch(new RegExp(`^t/${tenantB}/c/${companyB}/`))
    expect((await call('admin-b', 'GET', `/files/${one.id}`)).statusCode).toBe(404)
    expect((await download('admin-b', one.id)).status).toBe(404)
    expect((await call('admin-b', 'DELETE', `/files/${one.id}`)).statusCode).toBe(404)
    expect(await list('admin-b')).toEqual([other.json().file.id])
    expect(await list('admin')).not.toContain(other.json().file.id)
  })
})

describe('retention, legal hold and the fiscal archive (PLAN §2.8)', () => {
  const asOffice = (sql: string, ...values: unknown[]) =>
    database.withScope({ audience: 'office', tenantId: tenantA, actorId: user }, (client) => client.$executeRawUnsafe(sql, ...values))

  it('keeps a fiscal archive file ten years in the legal store, and refuses its delete and an earlier date', async () => {
    const body = Buffer.from('<?xml version="1.0"?><made-up-invoice/>')
    const { file, upload } = await announce(body, { kind: 'FISCAL_ARCHIVE', contentType: 'application/xml', originalName: 'IT00000000000_00001.xml' })
    expect(Date.parse(file.retainUntil!) - Date.now()).toBeGreaterThan(9.99 * 365 * 24 * 3600 * 1000)
    expect(await keyOf(file.id)).toMatch(new RegExp(`^legal/t/${tenantA}/c/${companyOne}/`))
    expect((await send(upload, body)).statusCode).toBe(200)
    const fiscal = (await call('admin', 'POST', `/files/${file.id}/complete`)).json().file as File

    const refused = await call('admin', 'DELETE', `/files/${fiscal.id}`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatchObject({ code: 'invalid_state', message: expect.stringMatching(/retention period to end/) })
    const earlier = await call('admin', 'PUT', `/files/${fiscal.id}/retention`, { retainUntil: '2030-01-01T00:00:00.000Z', reason: 'test earlier', version: fiscal.version })
    expect(earlier.statusCode).toBe(400)
    expect((await call('admin', 'PUT', `/files/${fiscal.id}/retention`, { reason: 'nothing at all', version: fiscal.version })).statusCode).toBe(400)
    const later = await call('admin', 'PUT', `/files/${fiscal.id}/retention`, { retainUntil: '2040-01-01T00:00:00.000Z', reason: 'audit extension', version: fiscal.version })
    expect(later.json().file).toMatchObject({ retainUntil: '2040-01-01T00:00:00.000Z' })

    // The database holds the same for every login: content fixed, no delete while retained, the date only later.
    await expect(asOffice(`UPDATE "StoredFile" SET sha256 = $1 WHERE id = $2::uuid`, 'b'.repeat(64), fiscal.id)).rejects.toThrow(/never changes/)
    await expect(asOffice(`UPDATE "StoredFile" SET "storageKey" = 'legal/x' WHERE id = $1::uuid`, fiscal.id)).rejects.toThrow(/never changes/)
    await expect(asOffice(`UPDATE "StoredFile" SET status = 'DELETED', "deletedAt" = now() WHERE id = $1::uuid`, fiscal.id)).rejects.toThrow(/is retained/)
    await expect(asOffice(`UPDATE "StoredFile" SET "retainUntil" = now() + interval '1 year' WHERE id = $1::uuid`, fiscal.id)).rejects.toThrow(/only moves later/)
    await expect(asOffice(`UPDATE "StoredFile" SET "retainUntil" = NULL WHERE id = $1::uuid`, fiscal.id)).rejects.toThrow(/needs its retention date/)
    await expect(admin(`DELETE FROM "StoredFile" WHERE id = $1`, [fiscal.id])).rejects.toThrow(/never deleted/)
    await expect(admin(`TRUNCATE "StoredFile" CASCADE`)).rejects.toThrow(/TRUNCATE on "StoredFile" is refused/)
    // The owner login too: a fiscal file stays one, in the legal store, with its content.
    await expect(admin(`UPDATE "StoredFile" SET kind = 'DOCUMENT' WHERE id = $1`, [fiscal.id])).rejects.toThrow(/legal store exactly when it is a fiscal archive file/)
    await expect(admin(`UPDATE "StoredFile" SET "contentType" = 'application/pdf' WHERE id = $1`, [fiscal.id])).rejects.toThrow(/never changes/)
    expect(existsSync(join(localRoot, await keyOf(fiscal.id)))).toBe(true)
  })

  it('refuses a delete under legal hold or before the retention date, then deletes: the row stays, the object goes', async () => {
    const held = await uploaded('held')
    const hold = await call('admin', 'PUT', `/files/${held.id}/retention`, { legalHold: true, reason: 'dispute with a made-up customer', version: held.version })
    expect(hold.json().file).toMatchObject({ legalHold: true })
    expect((await call('admin', 'DELETE', `/files/${held.id}`)).json().error.message).toMatch(/legal hold to be lifted/)
    await expect(asOffice(`UPDATE "StoredFile" SET status = 'DELETED', "deletedAt" = now() WHERE id = $1::uuid`, held.id)).rejects.toThrow(/is retained/)
    expect((await call('partner-one', 'GET', `/files/${held.id}`)).statusCode).toBe(404)
    const released = await call('admin', 'PUT', `/files/${held.id}/retention`, { legalHold: false, reason: 'dispute settled', version: held.version + 1 })
    expect(released.json().file).toMatchObject({ legalHold: false })

    const retained = await uploaded('retained', { retainUntil: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString() })
    expect((await call('admin', 'DELETE', `/files/${retained.id}`)).statusCode).toBe(409)

    const key = await keyOf(held.id)
    expect(existsSync(join(localRoot, key))).toBe(true)
    const deleted = await call('admin', 'DELETE', `/files/${held.id}?version=${held.version + 2}&reason=no%20longer%20needed`)
    expect(deleted.statusCode, deleted.body).toBe(200)
    expect(deleted.json().file).toMatchObject({ status: 'DELETED', deletedAt: expect.any(String) })
    expect(existsSync(join(localRoot, key))).toBe(false)
    expect((await callsOf(fakeStore)).filter((row) => (row.requestSummary as { key?: string } | null)?.key === key).map((row) => row.operation)).toContain('files.delete')
    expect((await call('admin', 'GET', `/files/${held.id}`)).json().file).toMatchObject({ status: 'DELETED' })
    expect(await list('admin')).not.toContain(held.id)
    expect((await download('admin', held.id)).status).toBe(409)
    expect((await call('admin', 'DELETE', `/files/${held.id}`)).statusCode).toBe(409)
    expect((await call('admin', 'PUT', `/files/${held.id}/visibility`, { visibility: [], version: held.version + 3 })).statusCode).toBe(409)
    const [audit] = await admin(`SELECT reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'files.delete'`, [held.id])
    expect(audit).toEqual({ reason: 'no longer needed' })
  })
})

describe('R2 through the gateway (A1 §4)', () => {
  it('presigns, confirms, downloads and deletes on R2: one ledger row per call, only HEAD and DELETE reach R2, no secret kept', async () => {
    const body = pdf('on r2')
    const { file, upload } = await announce(body, { companyId: companyTwo })
    const put = new URL(upload.url)
    expect(put.origin).toBe('https://example-account.eu.r2.cloudflarestorage.com')
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256')
    expect(upload.headers).toEqual({ 'content-type': 'application/pdf', 'x-amz-checksum-sha256': Buffer.from(sha256(body), 'hex').toString('base64') })
    const key = await keyOf(file.id)
    expect(decodeURIComponent(put.pathname)).toBe(`/factory-test/${key}`)
    expect(r2.requests).toEqual([])

    // The browser's PUT, as R2 would have stored it.
    r2.put('factory-test', key, { sizeBytes: body.length, contentType: 'application/pdf', sha256: sha256(body) })
    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).json().file).toMatchObject({ status: 'AVAILABLE' })
    const { download: get } = await download('admin', file.id)
    const url = new URL(get!.url)
    expect(url.searchParams.get('response-content-disposition')).toBe(`attachment; filename="Offer.pdf"; filename*=UTF-8''Offer.pdf`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect((await call('admin', 'DELETE', `/files/${file.id}`)).statusCode).toBe(200)

    expect(r2.requests.map((request) => [request.method, request.path])).toEqual([
      ['HEAD', `/factory-test/${key}`],
      ['DELETE', `/factory-test/${key}`],
    ])
    expect(r2.objects.size).toBe(0)
    const ledger = await callsOf(liveStore)
    expect(ledger.map((row) => [row.operation, row.status, row.mode])).toEqual([
      ['files.presign_upload', 'SUCCEEDED', 'LIVE'],
      ['files.head', 'SUCCEEDED', 'LIVE'],
      ['files.presign_download', 'SUCCEEDED', 'LIVE'],
      ['files.delete', 'SUCCEEDED', 'LIVE'],
    ])
    expect(JSON.stringify(await admin('SELECT * FROM "IntegrationCall"'))).not.toContain(R2_SECRET)
    expect(JSON.stringify(await admin('SELECT * FROM "AuditLog"'))).not.toContain(R2_SECRET)
  })

  it('a paused store (the kill switch) is not called: the upload is refused with 503 and recorded as refused', async () => {
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE id = $1`, [liveStore])
    try {
      const sent = r2.requests.length
      const response = await call('admin', 'POST', '/files', announcement(pdf('paused'), { companyId: companyTwo }))
      expect(response.statusCode).toBe(503)
      expect(response.json().error).toMatchObject({ code: 'not_ready' })
      expect(r2.requests.length).toBe(sent)
      expect((await callsOf(liveStore)).at(-1)).toMatchObject({ operation: 'files.presign_upload', status: 'REFUSED', reason: 'account_paused' })
    } finally {
      await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE id = $1`, [liveStore])
    }
  })
})
