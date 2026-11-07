import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant } from '@nexus/factory-domain/core/permissions'
import { localFileStore } from '../../../adapters/local-files/local'
import { r2FileStore } from '../../../adapters/r2/r2'
import { FakeR2 } from '../../../adapters/r2/testing'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createGateway } from '../../gateway/gateway'
import { useGateway } from '../../gateway/service'
import { systemContext } from '../../outbox/system'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { createSecretsService } from '../../secrets/envelope'
import { localKeyProvider } from '../../secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../../secrets/store'
import { prepareFileCopy, recordGeneratedFile } from '../files'
import { expireLargeUploads } from '../multipart/expiry'
import { assertOutsideUploadsOpen } from '../multipart/outside'
import { fakeScanner } from '../scan/fake'
import { useScanner } from '../scan/service'
import { createFilesRuntime, processFiles, useFiles } from '../service'
import { stripPicturesHandler } from '../thumbs/handler'

/**
 * Files in depth (B-W2b-160) on the local stack, through the app's real routes: versions and restore (COL-046, PLT-216),
 * the preview and the stripped copy outside the office (COL-047, COL-058), uploads in parts (COL-052) on the local store
 * (FAKE) and on "R2" (LIVE, the fake transport), copies that name their source (FV1:01) and the outside-upload gate
 * (FV1:02). A throwaway PostgreSQL 17 database from the migrations, the runtime login with row-level security and the
 * guard triggers real. Nothing here reaches a network service. Run with `node scripts/factory/run-pg-tests.mjs platform/files`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
const r2 = new FakeR2()

const tenant = newId()
const companyOne = newId()
const companyTwo = newId()
const site = newId()
const party = newId()
const otherParty = newId()
const user = newId()
const quote = newId()
const style = newId()
const fakeStore = newId()
let liveStore: string

const ALL = ['files.read', 'files.upload', 'files.delete', 'files.manage'] as const
const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const read = [grant(['files.read'])]
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(ALL)] },
  uploader: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(['files.read', 'files.upload'])] },
  viewer: { audience: 'office', tenantId: tenant, actorId: user, grants: read },
  partner: { audience: 'partner', tenantId: tenant, actorId: user, partyId: party, grants: read },
  'other-partner': { audience: 'partner', tenantId: tenant, actorId: user, partyId: otherParty, grants: read },
  link: { audience: 'link', tenantId: tenant, linkId: newId(), partyId: party, record: { type: 'Quote', id: quote }, grants: read },
  floor: { audience: 'floor', tenantId: tenant, actorId: user, siteId: site, deviceId: newId(), grants: read },
}

type File = { id: string; status: string; version: number; versionNo?: number; supersededAt?: string | null; seriesId?: string | null; sourceFileId?: string | null; sha256: string; visibility: string[]; quarantineReason: string | null; current?: boolean }
type Presigned = { method: string; url: string; headers: Record<string, string>; expiresAt: string }
type Session = { id: string; fileId: string; status: string; partSizeBytes: number; partCount: number; partsDone: { partNumber: number; sizeBytes: number }[]; missing: number[]; version: number }

const MIB = 1_048_576
const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string | undefined, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: session ? { 'x-test-session': session } : {}, ...(payload === undefined ? {} : { payload: payload as object }) })
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up test file: ${text}`)
const send = (upload: Presigned, body: Buffer) => app.inject({ method: 'PUT', url: upload.url, headers: upload.headers, payload: body })
const fetchBytes = async (url: string) => (await app.inject({ method: 'GET', url })).rawPayload
const audits = async (id: string) => (await admin<{ action: string }>('SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [id])).map((row) => row.action)
const rowOf = async (id: string) => (await admin('SELECT status, "versionNo", "seriesId", "supersededAt", "sourceFileId", "thumbnailKey", "exifStrippedAt", "storageKey" FROM "StoredFile" WHERE id = $1', [id]))[0]!
const record = (fields: Record<string, unknown> = {}) => ({ companyId: companyOne, recordType: 'Quote', recordId: quote, kind: 'DOCUMENT', ...fields })

async function announce(body: Buffer, fields: Record<string, unknown> = {}): Promise<{ file: File; upload: Presigned }> {
  const response = await call('admin', 'POST', '/files', { ...record(), originalName: 'Offer.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body), ...fields })
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
async function uploaded(body: Buffer, fields: Record<string, unknown> = {}): Promise<File> {
  const { file, upload } = await announce(body, fields)
  expect((await send(upload, body)).statusCode).toBe(200)
  const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return confirmed.json().file
}
async function newVersion(fileId: string, body: Buffer, fields: Record<string, unknown> = {}, session = 'admin') {
  return call(session, 'POST', `/files/${fileId}/versions`, { originalName: 'Offer v2.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body), ...fields })
}
async function versionUploaded(fileId: string, body: Buffer, fields: Record<string, unknown> = {}): Promise<File> {
  const answer = await newVersion(fileId, body, fields)
  expect(answer.statusCode, answer.body).toBe(201)
  const { file, upload } = answer.json() as { file: File; upload: Presigned }
  expect((await send(upload, body)).statusCode).toBe(200)
  const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return confirmed.json().file
}
const versionsOf = async (session: string, fileId: string) => {
  const answer = await call(session, 'GET', `/files/${fileId}/versions`)
  return { status: answer.statusCode, versions: answer.statusCode === 200 ? (answer.json().versions as File[]) : [] }
}

// A made-up phone photo: JFIF, EXIF with the orientation and a GPS block, XMP with a position, a comment, then the image.
const ascii = (text: string): number[] => Array.from(text, (c) => c.charCodeAt(0))
const segment = (marker: number, data: number[]): number[] => [0xff, marker, ((data.length + 2) >> 8) & 0xff, (data.length + 2) & 0xff, ...data]
function phonePhoto(): Buffer {
  const tiff = [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x02, 0x00]
  tiff.push(0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00)
  tiff.push(0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, ...ascii('GPS 45.4642N 9.1900E'))
  return Buffer.from([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii('JFIF\0'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xe1, [...ascii('Exif\0\0'), ...tiff]),
    ...segment(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/\0'), ...ascii('<exif:GPSLatitude>45,27.85N</exif:GPSLatitude>')]),
    ...segment(0xfe, ascii('made-up phone 12')),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    0x11, 0x22, 0xff, 0x00, 0x33,
    0xff, 0xd9,
  ])
}

beforeAll(async () => {
  db = await migratedDatabase('files_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-files-depth-test-'))
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'depth-a'])
  for (const [index, companyId] of [companyOne, companyTwo].entries()) {
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenant, `depth-${index}`])
  }
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'S0', 'S0', 'PLANT')`, [site, tenant, companyOne])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [fakeStore, tenant])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  // Company two keeps its files on "R2" (LIVE, the fake transport), its credentials sealed.
  liveStore = newId()
  const office = callerFor(database, { audience: 'office', tenantId: tenant, actorId: user, grants: [], requestId: newId() })
  await command(office, { name: 'integration.createAccount', input: { liveStore } }, async (tools) => {
    const secret = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.credentials, plaintext: JSON.stringify({ accessKeyId: 'made-up-access-key-id', secretAccessKey: 'made-up-secret-access-key-2c4f' }) })
    await tools.tx.integrationAccount.create({
      data: {
        id: liveStore,
        companyId: companyTwo,
        provider: 'R2',
        code: 'files-two',
        label: 'Files of company two',
        mode: 'LIVE',
        credentialsSecretId: secret.id,
        settings: { endpoint: 'https://example-account.eu.r2.cloudflarestorage.com', bucket: 'factory-test' },
        rateLimitPerMinute: 6000,
        rateLimitBurst: 1000,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: liveStore })
    return { id: liveStore }
  })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useGateway(gateway)
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }), r2: r2FileStore({ clientFor: r2.clientFor }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 600_000)

beforeEach(() => useScanner(null))

afterAll(async () => {
  useScanner(undefined)
  useFiles(undefined)
  useGateway(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('versions (COL-046, PLT-216)', () => {
  it('adds a version as a new object of the same series; the old one stays listed, superseded and read-only', async () => {
    const v1 = await uploaded(pdf('tech pack v1'), { visibility: ['OFFICE', 'PARTNER'], partyId: party })
    expect(v1).toMatchObject({ versionNo: 1, seriesId: null, supersededAt: null })
    const v2 = await versionUploaded(v1.id, pdf('tech pack v2'))
    expect(v2).toMatchObject({ status: 'AVAILABLE', versionNo: 2, seriesId: v1.id, supersededAt: null, visibility: ['OFFICE', 'PARTNER'] })
    // A new object: the old key is untouched in the store, the new one is another.
    const [one, two] = [await rowOf(v1.id), await rowOf(v2.id)]
    expect(two.storageKey).not.toBe(one.storageKey)
    expect(one.supersededAt).not.toBeNull()
    expect(await audits(v1.id)).toEqual(['files.requestUpload', 'files.completeUpload', 'files.supersedeVersion'])
    // The series as the office sees it, then the partner it is shared with; the floor reads no series.
    const office = await versionsOf('viewer', v2.id)
    expect(office.versions.map((file) => [file.versionNo, file.current])).toEqual([[1, false], [2, true]])
    expect((await versionsOf('partner', v1.id)).versions.map((file) => [file.versionNo, file.current, 'sourceFileId' in file])).toEqual([[1, false, false], [2, true, false]])
    expect((await versionsOf('other-partner', v1.id)).status).toBe(404)
    expect((await versionsOf('floor', v1.id)).status).toBe(403)
    // The record's file list still lists both, each with its number.
    const listed = (await call('viewer', 'GET', `/files?recordType=Quote&recordId=${quote}`)).json().files as File[]
    expect(listed.filter((file) => file.id === v1.id || file.id === v2.id).map((file) => file.versionNo).sort()).toEqual([1, 2])
    // Superseded = read-only: never shared more widely.
    const widen = await call('admin', 'PUT', `/files/${v1.id}/visibility`, { visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: party, version: (await versionsOf('admin', v1.id)).versions[0]!.version })
    expect(widen.statusCode).toBe(409)
    expect(widen.json().error.message).toBe('This is an earlier version: it is never shared more widely. Share the current version instead.')
    expect((await rowOf(v1.id)).status).toBe('AVAILABLE')
  })

  it('takes one new version at a time, none for a fiscal archive file or a module-owned record, and only with files.upload', async () => {
    const v1 = await uploaded(pdf('cost sheet v1'))
    const pending = await newVersion(v1.id, pdf('cost sheet v2'))
    expect(pending.statusCode, pending.body).toBe(201)
    const second = await newVersion(v1.id, pdf('cost sheet v3'))
    expect(second.statusCode).toBe(409)
    expect(second.json().error.message).toBe('Version 2 of this file is still uploading: confirm it or give it up first.')
    // Given up (DELETE of the pending version): the series takes a new one, numbered after it (numbers are never reused).
    expect((await call('admin', 'DELETE', `/files/${(pending.json().file as File).id}`)).statusCode).toBe(200)
    const v3 = await versionUploaded(v1.id, pdf('cost sheet v3'))
    expect(v3.versionNo).toBe(3)
    expect((await newVersion(v1.id, pdf('by a viewer'), {}, 'viewer')).statusCode).toBe(403)
    // Sharing a new version beyond the office needs files.manage, as at upload.
    expect((await newVersion(v3.id, pdf('shared'), { visibility: ['OFFICE', 'PARTNER'], partyId: party }, 'uploader')).statusCode).toBe(403)

    const fiscal = await uploaded(pdf('invoice'), { kind: 'FISCAL_ARCHIVE', recordType: 'Invoice', recordId: newId() })
    const refused = await newVersion(fiscal.id, pdf('invoice 2'))
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toContain('fiscal archive')
    // A record type its module owns: its own route, never the generic one.
    const [owned] = await admin<{ id: string }>(
      `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storeAccountId", "storageKey", status, "availableAt")
       VALUES ($1, $2, $3, 'Certificate', $4, 'CERTIFICATE', 'Cert.pdf', 'application/pdf', 10, $5, $6, $7, 'AVAILABLE', now()) RETURNING id`,
      [newId(), tenant, companyOne, newId(), 'cd'.repeat(32), fakeStore, `t/${tenant}/c/${companyOne}/2026/${newId()}`],
    )
    const moduleOwned = await newVersion(owned!.id, pdf('cert 2'))
    expect(moduleOwned.statusCode).toBe(409)
    expect(moduleOwned.json().error.message).toContain('/compliance/certificates')
  })

  it('with the scanner on, the old version stays current until the new one is CLEAN', async () => {
    const v1 = await uploaded(pdf('pattern v1'))
    useScanner(fakeScanner())
    const answer = await newVersion(v1.id, pdf('pattern v2'))
    const { file, upload } = answer.json() as { file: File; upload: Presigned }
    expect((await send(upload, pdf('pattern v2'))).statusCode).toBe(200)
    const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
    expect(confirmed.json().file).toMatchObject({ status: 'AVAILABLE', versionNo: 2 })
    expect((await rowOf(v1.id)).supersededAt).not.toBeNull()
    expect(await audits(file.id)).toEqual(['files.requestVersion', 'files.completeUpload', 'files.recordScan'])
  })

  it('restores an earlier version as the next one: a copy naming its source, the current one superseded', async () => {
    const v1 = await uploaded(pdf('spec v1'))
    const v2 = await versionUploaded(v1.id, pdf('spec v2'))
    expect((await call('admin', 'POST', `/files/${v2.id}/restore`)).statusCode).toBe(409)
    const restored = await call('uploader', 'POST', `/files/${v1.id}/restore`)
    expect(restored.statusCode, restored.body).toBe(201)
    const v3 = restored.json().file as File
    expect(v3).toMatchObject({ status: 'AVAILABLE', versionNo: 3, seriesId: v1.id, sourceFileId: v1.id, sha256: sha256(pdf('spec v1')) })
    expect((await versionsOf('viewer', v1.id)).versions.map((file) => [file.versionNo, file.current])).toEqual([[1, false], [2, false], [3, true]])
    expect(await audits(v3.id)).toEqual(['files.restoreVersion'])
    const bytes = await fetchBytes(((await call('admin', 'GET', `/files/${v3.id}/download`)).json().download as Presigned).url)
    expect(Buffer.from(bytes).toString()).toBe(pdf('spec v1').toString())
  })
})

describe('preview (COL-047) and the stripped copy outside the office (COL-058)', () => {
  it('opens a PDF in the browser for 60 seconds and downloads a CSV', async () => {
    const file = await uploaded(pdf('to preview'))
    const answer = await call('viewer', 'GET', `/files/${file.id}/preview`)
    expect(answer.statusCode, answer.body).toBe(200)
    const preview = answer.json().preview as Presigned & { mode: string }
    expect(preview.mode).toBe('inline')
    expect(new Date(preview.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000)
    const opened = await app.inject({ method: 'GET', url: preview.url })
    expect(opened.headers['content-disposition']).toMatch(/^inline; filename="Offer.pdf"/)
    expect(opened.headers['content-type']).toContain('application/pdf')
    const csv = Buffer.from('made-up;csv\n1;2\n')
    const sheet = await uploaded(csv, { kind: 'ATTACHMENT', originalName: 'sizes.csv', contentType: 'text/csv' })
    const download = (await call('viewer', 'GET', `/files/${sheet.id}/preview`)).json().preview
    expect(download.mode).toBe('download')
    expect((await app.inject({ method: 'GET', url: download.url })).headers['content-disposition']).toMatch(/^attachment;/)
  })

  it('shows a portal or a link a phone photo only without its EXIF and position; the office gets the original', async () => {
    const photo = phonePhoto()
    const file = await uploaded(photo, { kind: 'PHOTO', originalName: 'sample.jpg', contentType: 'image/jpeg', visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: party })
    // The worker's job after file.available (here called as the worker does).
    const handler = stripPicturesHandler({ files: processFiles })
    await handler.handle(
      { eventId: newId(), type: 'file.available', version: 1, tenantId: tenant, companyId: companyOne, subject: file.id, correlationId: newId(), causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload: { fileId: file.id, recordType: 'Quote', recordId: quote, kind: 'PHOTO' } } as never,
      { caller: callerFor(database, systemContext(tenant, newId())), attempt: 1 } as never,
    )
    const row = await rowOf(file.id)
    expect(row.thumbnailKey).not.toBeNull()
    expect(row.exifStrippedAt).not.toBeNull()
    for (const session of ['partner', 'link']) {
      const preview = (await call(session, 'GET', `/files/${file.id}/preview`)).json().preview
      const shown = Buffer.from(await fetchBytes(preview.url)).toString('latin1')
      expect(shown).not.toContain('GPS')
      expect(shown).not.toContain('made-up phone')
      expect(shown.startsWith('\xff\xd8')).toBe(true)
      const download = (await call(session, 'GET', `/files/${file.id}/download`)).json().download
      expect(Buffer.from(await fetchBytes(download.url)).toString('latin1')).not.toContain('GPS')
    }
    const original = (await call('viewer', 'GET', `/files/${file.id}/download`)).json().download
    expect(Buffer.from(await fetchBytes(original.url)).toString('latin1')).toContain('GPS 45.4642N')
    expect(await audits(file.id)).toContain('files.recordStrippedCopy')
  })

  it('makes the stripped copy at the portal\'s first look when the worker has not, and never shows a HEIC outside the office', async () => {
    const file = await uploaded(phonePhoto(), { kind: 'PHOTO', originalName: 'late.jpg', contentType: 'image/jpeg', visibility: ['OFFICE', 'PARTNER'], partyId: party })
    expect((await rowOf(file.id)).thumbnailKey).toBeNull()
    const preview = await call('partner', 'GET', `/files/${file.id}/preview`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect((await rowOf(file.id)).thumbnailKey).not.toBeNull()
    const heic = Buffer.from('made-up heic bytes')
    const other = await uploaded(heic, { kind: 'PHOTO', originalName: 'iphone.heic', contentType: 'image/heic', visibility: ['OFFICE', 'PARTNER'], partyId: party })
    const refused = await call('partner', 'GET', `/files/${other.id}/download`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toContain('cannot be shown outside the office')
    expect((await call('viewer', 'GET', `/files/${other.id}/download`)).statusCode).toBe(200)
  })
})

describe('uploads in parts (COL-052)', () => {
  const big = Buffer.concat([Buffer.alloc(5 * MIB, 7), Buffer.alloc(5 * MIB, 8), pdf('the end of a large tech pack')])
  const partOf = (n: number) => big.subarray((n - 1) * 5 * MIB, Math.min(big.length, n * 5 * MIB))

  async function start(body: Buffer, fields: Record<string, unknown> = {}) {
    const answer = await call('admin', 'POST', '/files/uploads', { ...record(), originalName: 'Tech pack.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body), partSizeBytes: 5 * MIB, ...fields })
    expect(answer.statusCode, answer.body).toBe(201)
    return answer.json() as { file: File; session: Session }
  }
  async function sendParts(sessionId: string, numbers: number[], body = big) {
    const answer = await call('admin', 'POST', `/files/uploads/${sessionId}/parts`, { parts: numbers.map((n) => ({ partNumber: n, sha256: sha256(body.subarray((n - 1) * 5 * MIB, Math.min(body.length, n * 5 * MIB))) })) })
    expect(answer.statusCode, answer.body).toBe(200)
    for (const part of answer.json().parts as Array<Presigned & { partNumber: number }>) {
      const sent = await send(part, body.subarray((part.partNumber - 1) * 5 * MIB, Math.min(body.length, part.partNumber * 5 * MIB)))
      expect(sent.statusCode, sent.body).toBe(200)
    }
  }

  it('resumes after a dropped line: only the missing parts are sent again, then the file is checked whole', async () => {
    const { file, session } = await start(big)
    expect(session).toMatchObject({ status: 'OPEN', partCount: 3, partsDone: [], missing: [1, 2, 3] })
    expect(file).toMatchObject({ status: 'PENDING_UPLOAD', versionNo: 1 })
    await sendParts(session.id, [1, 3])
    // The line drops: the resume asks the store what it holds.
    const synced = (await call('admin', 'POST', `/files/uploads/${session.id}/sync`)).json().session as Session
    expect(synced.missing).toEqual([2])
    expect(synced.partsDone.map((part) => part.partNumber)).toEqual([1, 3])
    const early = await call('admin', 'POST', `/files/uploads/${session.id}/complete`)
    expect(early.statusCode).toBe(409)
    expect(early.json().error.message).toBe('Part 2 of 3 has not arrived yet: send it, then complete the upload.')
    expect((await call('admin', 'POST', `/files/uploads/${session.id}/parts`, { parts: [{ partNumber: 1, sha256: sha256(partOf(1)) }] })).statusCode).toBe(400)
    // The plain confirm is refused for a file in parts.
    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(409)
    await sendParts(session.id, [2])
    const done = await call('admin', 'POST', `/files/uploads/${session.id}/complete`)
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toMatchObject({ file: { status: 'AVAILABLE', sha256: sha256(big) }, session: { status: 'COMPLETED', missing: [] } })
    const bytes = await fetchBytes(((await call('admin', 'GET', `/files/${file.id}/download`)).json().download as Presigned).url)
    expect(sha256(Buffer.from(bytes))).toBe(sha256(big))
    expect((await call('admin', 'POST', `/files/uploads/${session.id}/complete`)).json().session.status).toBe('COMPLETED')
    expect(await audits(session.id)).toEqual(['files.startLargeUpload', 'files.recordUploadParts', 'files.recordUploadParts', 'files.completeLargeUpload'])
  })

  it('holds a file that is not the one announced, gives an upload up, and expires one after seven days', async () => {
    const wrong = await start(big, { sha256: sha256(pdf('something else')) })
    await sendParts(wrong.session.id, [1, 2, 3])
    expect((await call('admin', 'POST', `/files/uploads/${wrong.session.id}/complete`)).json().file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'checksum_mismatch' })

    const given = await start(big)
    await sendParts(given.session.id, [1])
    const aborted = await call('admin', 'DELETE', `/files/uploads/${given.session.id}`)
    expect(aborted.statusCode, aborted.body).toBe(200)
    expect(aborted.json()).toMatchObject({ file: { status: 'DELETED' }, session: { status: 'ABORTED' } })
    expect((await call('admin', 'POST', `/files/uploads/${given.session.id}/parts`, { parts: [{ partNumber: 2, sha256: sha256(partOf(2)) }] })).statusCode).toBe(409)

    const old = await start(big)
    const log = { info() {}, warn() {}, error() {} } as never
    const later = { now: () => new Date(Date.now() + 8 * 86_400_000) }
    const result = await expireLargeUploads({ database, log, clock: later })
    expect(result.expired).toBeGreaterThanOrEqual(1)
    expect((await call('admin', 'GET', `/files/uploads/${old.session.id}`)).json()).toMatchObject({ file: { status: 'DELETED' }, session: { status: 'EXPIRED' } })
  })

  it('sends a large new version in parts on R2 (LIVE): the store joins it, the API reads it whole, the old version is superseded', async () => {
    // Version 1 on R2: the browser's PUT, as the fake transport holds it.
    const first = pdf('marker v1')
    const { file: announced } = await announce(first, { companyId: companyTwo })
    r2.put('factory-test', (await rowOf(announced.id)).storageKey, { sizeBytes: first.length, contentType: 'application/pdf', sha256: sha256(first), body: first })
    const v1 = (await call('admin', 'POST', `/files/${announced.id}/complete`)).json().file as File
    expect(v1.status).toBe('AVAILABLE')
    const answer = await call('admin', 'POST', `/files/${v1.id}/versions/uploads`, { originalName: 'Marker v2.pdf', contentType: 'application/pdf', sizeBytes: big.length, sha256: sha256(big), partSizeBytes: 5 * MIB })
    expect(answer.statusCode, answer.body).toBe(201)
    const { file, session } = answer.json() as { file: File; session: Session }
    expect(file).toMatchObject({ versionNo: 2, seriesId: v1.id })
    const signed = (await call('admin', 'POST', `/files/uploads/${session.id}/parts`, { parts: [1, 2, 3].map((n) => ({ partNumber: n, sha256: sha256(partOf(n)) })) })).json().parts as Presigned[]
    expect(signed.every((part) => part.url.startsWith('https://example-account.eu.r2.cloudflarestorage.com/'))).toBe(true)
    // The browser's PUTs to R2, as the fake transport takes them.
    const uploadId = [...r2.uploads.keys()].at(-1)!
    for (const n of [1, 2, 3]) r2.sendPart(uploadId, n, Buffer.from(partOf(n)))
    const done = await call('admin', 'POST', `/files/uploads/${session.id}/complete`)
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json().file).toMatchObject({ status: 'AVAILABLE', versionNo: 2 })
    expect((await rowOf(v1.id)).supersededAt).not.toBeNull()
    const ledger = await admin<{ operation: string }>('SELECT operation FROM "IntegrationCall" WHERE "accountId" = $1 ORDER BY "startedAt", id', [liveStore])
    expect(ledger.map((row) => row.operation)).toEqual(expect.arrayContaining(['files.multipart_start', 'files.multipart_presign', 'files.multipart_parts', 'files.multipart_complete', 'files.digest']))
  })

  it('refuses a fiscal archive file, a part size under 5 MiB and a file over the limit', async () => {
    const body = { ...record(), originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 300 * MIB, sha256: 'ab'.repeat(32) }
    expect((await call('admin', 'POST', '/files/uploads', body)).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/files/uploads', { ...body, sizeBytes: 10 * MIB, kind: 'FISCAL_ARCHIVE' })).statusCode).toBe(400)
    expect((await call('admin', 'POST', '/files/uploads', { ...body, sizeBytes: 10 * MIB, partSizeBytes: MIB })).statusCode).toBe(400)
    expect((await call('viewer', 'POST', '/files/uploads', { ...body, sizeBytes: 10 * MIB })).statusCode).toBe(403)
  })
})

describe('copies name their source (FV1:01) and uploads from outside wait for the scanner (FV1:02)', () => {
  it('writes sourceFileId on every copy prepareFileCopy makes', async () => {
    const source = await uploaded(pdf('DoC of a style'), { recordType: 'Style', recordId: style })
    const caller = callerFor(database, systemContext(tenant, newId()))
    const copy = await prepareFileCopy(processFiles(), caller, source.id, { companyId: companyOne, recordType: 'Shipment', recordId: newId(), visibility: ['OFFICE', 'LINK'], partyId: party })
    const { result } = await command(caller, { name: 'files.storeGenerated', input: { copy: source.id } }, (tools) => recordGeneratedFile(tools, copy))
    expect((await rowOf(result.id)).sourceFileId).toBe(source.id)
    expect(result.sourceFileId).toBe(source.id)
  })

  it('closes uploads from outside in a live environment without the scanner, open with ClamAV or in a test run', () => {
    useScanner(null)
    expect(() => assertOutsideUploadsOpen('production')).toThrow('virus scanner is not running')
    expect(() => assertOutsideUploadsOpen('test')).not.toThrow()
    useScanner({ kind: 'clamav', scan: async () => ({ verdict: 'CLEAN', engine: 'ClamAV made-up' }) })
    expect(() => assertOutsideUploadsOpen('production')).not.toThrow()
  })
})
