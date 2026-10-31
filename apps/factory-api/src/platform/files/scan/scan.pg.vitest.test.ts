import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createGateway } from '../../gateway/gateway'
import { useGateway } from '../../gateway/service'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { createSecretsService } from '../../secrets/envelope'
import { localKeyProvider } from '../../secrets/local'
import { createFilesRuntime, useFiles } from '../service'
import { EICAR, FAKE_SCAN_FAIL, fakeScanner, type FakeScanner } from './fake'
import type { ScanVerdict, VirusScanner } from './port'
import { scanningOn, useScanner } from './service'
import { sweepPendingScans } from './sweep'

/**
 * The virus scan on uploads (PLT-245; B-W2a-42) on the local stack, through the app's real files routes: a throwaway
 * PostgreSQL 17 database (the runtime login, row-level security and the StoredFile guard trigger are real), the local
 * file store (a FAKE R2 account) and the FAKE scanner. Uploads wait QUARANTINED until the scan says CLEAN; an infected
 * file is never served (and the database refuses to make it available); a scanner that does not answer holds the file
 * in words, never "clean" by default; Try again (confirm again) and the sweep scan it later. Made-up files only.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/files/scan`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let scanner: FakeScanner

const tenant = newId()
const company = newId()
const site = newId()
const user = newId()
const quote = newId()
const store = newId()

const ALL = ['files.read', 'files.upload', 'files.delete', 'files.manage'] as const
const grant = (permissions: Grant['permissions']): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  admin: { audience: 'office', tenantId: tenant, actorId: user, grants: [grant(ALL)] },
  floor: { audience: 'floor', tenantId: tenant, actorId: user, siteId: site, deviceId: newId(), grants: [grant(['files.read'])] },
}

type File = Record<string, any> & { id: string; status: string; scanStatus: string; quarantineReason: string | null; version: number }
type Presigned = { method: string; url: string; headers: Record<string, string> }

const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.7 made-up test file: ${text}`)

/** Announce, send to the local store and confirm: the confirm's answer. */
async function upload(body: Buffer, fields: Record<string, unknown> = {}): Promise<{ status: number; file: File }> {
  const announced = await call('admin', 'POST', '/files', {
    companyId: company,
    recordType: 'Quote',
    recordId: quote,
    kind: 'DOCUMENT',
    originalName: 'Offer.pdf',
    contentType: 'application/pdf',
    sizeBytes: body.length,
    sha256: sha256(body),
    ...fields,
  })
  expect(announced.statusCode, announced.body).toBe(201)
  const { file, upload: put } = announced.json() as { file: File; upload: Presigned }
  const sent = await app.inject({ method: 'PUT', url: put.url, headers: put.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  const confirmed = await call('admin', 'POST', `/files/${file.id}/complete`)
  return { status: confirmed.statusCode, file: confirmed.json().file }
}
const confirm = async (fileId: string) => {
  const answer = await call('admin', 'POST', `/files/${fileId}/complete`)
  expect(answer.statusCode, answer.body).toBe(200)
  return answer.json().file as File
}
const downloadStatus = async (session: string, fileId: string) => (await call(session, 'GET', `/files/${fileId}/download`)).statusCode
const audits = async (fileId: string) => (await admin<{ action: string }>('SELECT action FROM "AuditLog" WHERE "recordId" = $1 ORDER BY at, id', [fileId])).map((row) => row.action)
const events = async (fileId: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [fileId])).map((row) => row.type)

/** A scanner that answers each scan from a list (then CLEAN). */
function scripted(...answers: Array<ScanVerdict['verdict']>): VirusScanner & { readonly calls: number } {
  let calls = 0
  return {
    kind: 'fake',
    get calls() {
      return calls
    },
    async scan() {
      const answer = answers[calls++] ?? 'CLEAN'
      return answer === 'CLEAN' ? { verdict: 'CLEAN', engine: 'Scripted 1' } : { verdict: answer, engine: 'Scripted 1', finding: answer === 'INFECTED' ? 'Made-Up-Signature' : 'The scanner could not read this file.' }
    },
  } as VirusScanner & { readonly calls: number }
}

beforeAll(async () => {
  db = await migratedDatabase('files_scan')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-scan-test-'))
  await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenant, 'scan-a'])
  await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [company, tenant, 'scan-a-0'])
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'S0', 'S0', 'PLANT')`, [site, tenant, company])
  await admin(
    `INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`,
    [store, tenant],
  )
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  // B-W2b-24: the scans of a tenant with a virus-scan account go through the process gateway.
  useGateway(gateway)
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 60_000)

beforeEach(() => {
  scanner = fakeScanner()
  useScanner(scanner)
})

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

describe('without a scanner (FACTORY_VIRUS_SCAN off)', () => {
  it('a matching upload becomes AVAILABLE unscanned, as before', async () => {
    useScanner(null)
    expect(scanningOn()).toBe(false)
    const { status, file } = await upload(pdf('no scanner'))
    expect(status).toBe(200)
    expect(file).toMatchObject({ status: 'AVAILABLE', scanStatus: 'NOT_SCANNED', scannedAt: null, quarantineReason: null })
    expect(await events(file.id)).toEqual(['file.available'])
  })
})

describe('with a scanner, an upload waits until the scan says clean', () => {
  it('a clean file: QUARANTINED while scanned, then AVAILABLE with the verdict; one file.available; audited', async () => {
    expect(scanningOn()).toBe(true)
    const { status, file } = await upload(pdf('clean'))
    expect(status).toBe(200)
    expect(file).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN', scanEngine: 'Fake scanner 1', scanFinding: null, quarantineReason: null })
    expect(file.scannedAt).toEqual(expect.any(String))
    expect(scanner.scans).toBe(1)
    expect(await audits(file.id)).toEqual(['files.requestUpload', 'files.completeUpload', 'files.recordScan'])
    const [held] = await admin<{ after: Record<string, unknown> }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'files.completeUpload'`, [file.id])
    expect(held!.after).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'scan_pending', scanStatus: 'PENDING' })
    expect(await events(file.id)).toEqual(['file.available'])
    expect(await downloadStatus('admin', file.id)).toBe(200)
    // A repeat of the confirm changes nothing and scans nothing.
    expect(await confirm(file.id)).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
    expect(scanner.scans).toBe(1)
  })

  it('an infected file stays QUARANTINED with the signature; it is never served, and the database refuses to make it available', async () => {
    const { file } = await upload(Buffer.from(EICAR, 'latin1'), { kind: 'ATTACHMENT', originalName: 'eicar.txt', contentType: 'text/plain' })
    expect(file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'virus_found', scanStatus: 'INFECTED', scanFinding: 'Eicar-Test-Signature' })
    expect(await events(file.id)).toEqual([])
    expect(await downloadStatus('admin', file.id)).toBe(409)
    expect(await downloadStatus('floor', file.id)).toBe(404)
    await expect(admin(`UPDATE "StoredFile" SET status = 'AVAILABLE', "availableAt" = now() WHERE id = $1`, [file.id])).rejects.toThrow(/infected|cannot move/)
    await expect(admin(`UPDATE "StoredFile" SET "scanStatus" = 'PENDING', "scannedAt" = NULL, "scanEngine" = NULL, "scanFinding" = NULL WHERE id = $1`, [file.id])).rejects.toThrow(/cannot move/)
    // Confirming again neither rescans nor releases it.
    expect((await call('admin', 'POST', `/files/${file.id}/complete`)).statusCode).toBe(409)
    expect(scanner.scans).toBe(1)
  })

  it('a scanner that does not answer holds the file in words: QUARANTINED, PENDING, never clean; Try again scans it', async () => {
    scanner.down()
    const { status, file } = await upload(pdf('scanner down'))
    expect(status).toBe(200)
    expect(file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'scan_pending', scanStatus: 'PENDING', scannedAt: null, scanEngine: null })
    expect(await downloadStatus('admin', file.id)).toBe(409)
    expect(await events(file.id)).toEqual([])
    // Still down: confirming again changes nothing.
    expect(await confirm(file.id)).toMatchObject({ status: 'QUARANTINED', scanStatus: 'PENDING' })
    scanner.up()
    expect(await confirm(file.id)).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
    expect(await events(file.id)).toEqual(['file.available'])
    expect(await downloadStatus('admin', file.id)).toBe(200)
  })

  it('a scan that failed stays held with why; Try again moves FAILED → PENDING → CLEAN, audited', async () => {
    const once = scripted('FAILED')
    useScanner(once)
    const { file } = await upload(pdf('fails once'))
    expect(file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'scan_failed', scanStatus: 'FAILED', scanFinding: 'The scanner could not read this file.' })
    expect(await downloadStatus('admin', file.id)).toBe(409)
    expect(await confirm(file.id)).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN', scanFinding: null, quarantineReason: null })
    expect(once.calls).toBe(2)
    expect(await audits(file.id)).toEqual(['files.requestUpload', 'files.completeUpload', 'files.recordScan', 'files.rescan', 'files.recordScan'])
  })

  it('the fake scanner cannot read its marked file: FAILED', async () => {
    const { file } = await upload(Buffer.from(`made-up ${FAKE_SCAN_FAIL}`), { kind: 'ATTACHMENT', originalName: 'archive.txt', contentType: 'text/plain' })
    expect(file).toMatchObject({ status: 'QUARANTINED', scanStatus: 'FAILED', quarantineReason: 'scan_failed' })
  })

  it('a mismatching upload is quarantined for its mismatch and never scanned', async () => {
    const body = pdf('announced')
    const announced = await call('admin', 'POST', '/files', { companyId: company, recordType: 'Quote', recordId: quote, kind: 'DOCUMENT', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha256(body) })
    const { file, upload: put } = announced.json() as { file: File; upload: Presigned }
    expect((await app.inject({ method: 'PUT', url: put.url, headers: put.headers, payload: body })).statusCode).toBe(200)
    // The store now holds other bytes under the key (as if the object were replaced): the confirmation catches it.
    const key = (await admin<{ storageKey: string }>('SELECT "storageKey" FROM "StoredFile" WHERE id = $1', [file.id]))[0]!.storageKey
    writeFileSync(join(localRoot, key), pdf('replaced!'))
    const answer = await call('admin', 'POST', `/files/${file.id}/complete`)
    expect(answer.json().file).toMatchObject({ status: 'QUARANTINED', quarantineReason: 'checksum_mismatch', scanStatus: 'NOT_SCANNED' })
    expect(scanner.scans).toBe(0)
  })

  it('the floor sees the scan state of a file shared with it, never the scanner or what it found', async () => {
    const { file } = await upload(pdf('for the floor'), { visibility: ['FLOOR'], floorSiteId: site })
    expect(file.status).toBe('AVAILABLE')
    const seen = (await call('floor', 'GET', `/files/${file.id}`)).json().file as File
    expect(seen).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
    expect(seen).not.toHaveProperty('scanEngine')
    expect(seen).not.toHaveProperty('scanFinding')
  })
})

describe('the sweep (files.scanPending)', () => {
  it('scans the uploads still held for their scan once the scanner answers; while it is down they stay held', async () => {
    scanner.down()
    const { file } = await upload(pdf('swept'))
    expect(file).toMatchObject({ status: 'QUARANTINED', scanStatus: 'PENDING' })
    const log = { info() {}, warn() {}, error() {} }
    const later = { now: () => new Date(Date.now() + 5 * 60_000) }
    expect(await sweepPendingScans({ database, log, clock: later, scanner })).toMatchObject({ scanned: 0, scanner_unavailable: 1 })
    expect((await admin<{ status: string }>('SELECT status::text FROM "StoredFile" WHERE id = $1', [file.id]))[0]!.status).toBe('QUARANTINED')
    // Not yet a minute old: the sweep leaves it to the person's own confirm.
    scanner.up()
    expect(await sweepPendingScans({ database, log, scanner })).toMatchObject({ scanned: 0 })
    expect(await sweepPendingScans({ database, log, clock: later, scanner })).toMatchObject({ scanned: 1 })
    const [row] = await admin<{ status: string; scanStatus: string }>('SELECT status::text, "scanStatus"::text FROM "StoredFile" WHERE id = $1', [file.id])
    expect(row).toEqual({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
    expect(await audits(file.id)).toContain('files.recordScan')
    // Scanning off: the tick does nothing.
    expect(await sweepPendingScans({ database, log, clock: later, scanner: null })).toMatchObject({ scanned: 0, scanner_unavailable: 0 })
  })
})

describe('B-W2b-24: with a virus-scan account (CLAMAV), each scan is ledgered for the tenant', () => {
  it('one IntegrationCall per scan (the verdict, never the bytes); a paused account holds the file as a scanner that did not answer', async () => {
    const account = newId()
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'CLAMAV', 'scan', 'Virus scan (fake)', 'FAKE', 6000, 1000)`, [account, tenant])
    const { file } = await upload(pdf('ledgered'))
    expect(file).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
    const calls = await admin<Record<string, unknown>>(`SELECT provider, operation, status, "companyId" FROM "IntegrationCall" WHERE "accountId" = $1`, [account])
    expect(calls).toEqual([{ provider: 'CLAMAV', operation: 'files.scan', status: 'SUCCEEDED', companyId: null }])
    const [summary] = await admin<{ request: unknown; response: unknown }>(`SELECT "requestSummary" AS request, "responseSummary" AS response FROM "IntegrationCall" WHERE "accountId" = $1`, [account])
    expect(summary).toMatchObject({ request: { fileId: file.id, engine: 'fake' }, response: { verdict: 'CLEAN', engine: 'Fake scanner 1' } })
    expect((await admin<{ lastOkAt: Date | null }>(`SELECT "lastOkAt" FROM "IntegrationAccount" WHERE id = $1`, [account]))[0]!.lastOkAt).not.toBeNull()
    // The kill switch: a PAUSED account calls nothing; the upload waits, held for its scan.
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE id = $1`, [account])
    const held = await upload(pdf('paused'))
    expect(held.file).toMatchObject({ status: 'QUARANTINED', scanStatus: 'PENDING', quarantineReason: 'scan_pending' })
    expect(await admin(`SELECT status, reason FROM "IntegrationCall" WHERE "accountId" = $1 ORDER BY "startedAt"`, [account])).toEqual([
      { status: 'SUCCEEDED', reason: null },
      { status: 'REFUSED', reason: 'account_paused' },
    ])
    await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE id = $1`, [account])
    expect(await confirm(held.file.id)).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
  })
})
