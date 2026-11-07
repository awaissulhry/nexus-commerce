import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { PAY_RECORD_TYPES } from '@nexus/factory-domain/links/pay'
import { LINK_RENEW_ANSWER } from '@nexus/factory-domain/links/renew'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../packages/factory-db/seed/email'
import { seed as seedFiles } from '../../../../../packages/factory-db/seed/files'
import { seed as seedParties } from '../../../../../packages/factory-db/seed/parties'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../adapters/local-files/local'
import { FakeSes, textOf, type FakeMail } from '../../adapters/ses/fake'
import { sesMailAdapter } from '../../adapters/ses/ses'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import type { Clock } from '../../core/time'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../env'
import { createAbuseGuard, useAbuseGuard } from '../abuse/guard'
import { memoryAbuseStore } from '../abuse/store'
import { createOfficeAuth, type OfficeAuth } from '../auth/sessions/office-auth'
import { createEmailRuntime, useEmail } from '../email-out/service'
import { storeGeneratedFile } from '../files/files'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../files/service'
import { createGateway } from '../gateway/gateway'
import { systemContext } from '../outbox/system'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { carriesLink, LINK_HEADER, LINK_UNAVAILABLE, linkAuthenticator } from './authenticator'
import { UNLOCK_HEADER } from './contract'
import { purgeLinkDrafts } from './drafts'

/**
 * Links in depth (B-W2b-163; COL-051, MES-274; design links.document, links.file, links.frame) through the app's real
 * routes on a throwaway PostgreSQL 17 (the runtime login: row-level security, the grants and the …_links_depth_w2b_guards
 * are real; a local file store as FAKE R2; FAKE SES): a set of files with a password sent apart, mailed to the contact on
 * file; the password's five tries and its hold; downloads as evidence; the receipt; a newer version named; "Ask for a new
 * link" with its one answer; drafts kept with us, sealed, and their purge; pay figures never by link. Every name and file
 * is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/links`.
 */

const WEB_ORIGIN = 'http://localhost:3200'
const NS = 'links-depth-api'
const id = (key: string) => seedUuid(NS, key)
const T = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B'), P1: id('party:P1'), P2: id('party:P2'), buyer: id('party-contact:P1:buyer'), store: id('files:account:r2'), actor: id('actor') }
const BUYER = 'buyer.p1@example.com'
const PASSWORD = 'made-up pass 7'

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let auth: OfficeAuth
const ses = new FakeSes()
const clock: Clock = { now: () => new Date() }

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: T.tenant, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  sender: office([grant(['links.view', 'links.manage', 'files.read'])]),
  noFiles: office([grant(['links.view', 'links.manage'])]),
  viewer: office([grant(['links.view', 'files.read'])]),
}

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await db.admin.query(sql, values)).rows as R[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `links-depth-${run}-${++keys}`
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
/** A request of a link's holder: the token in x-factory-link, an unlock key when given, an Idempotency-Key on writes. */
const asLink = (token: string | undefined, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, unlock?: string) =>
  app.inject({
    method,
    url,
    headers: { ...(token === undefined ? {} : { [LINK_HEADER]: token }), ...(unlock ? { [UNLOCK_HEADER]: unlock } : {}), ...(method === 'GET' ? {} : { 'idempotency-key': key() }), 'user-agent': 'Made-up Browser/1.0' },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
const mailsTo = (address: string): FakeMail[] => ses.mails.filter((mail) => mail.to.includes(address))
const tokenOf = (mail: FakeMail): string => decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))![1]!)
const pathsOf = (body: Json): string[] => (body.error?.issues ?? []).map((issue: Json) => issue.path)
const system = () => callerFor(database, systemContext(T.tenant, newId()))
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% made-up document: ${text}\n%%EOF\n`)
/** A fresh abuse guard (its own memory): each test of "Ask for a new link" starts with no traffic counted. */
const freshGuard = () => useAbuseGuard(createAbuseGuard({ store: memoryAbuseStore(), key: Buffer.alloc(32, 7), prefix: 'test', clock }))

async function storeFile(name: string, recordType = 'Style', companyId: string | null = T.companyA): Promise<string> {
  const made = await storeGeneratedFile(files, system(), { companyId, recordType, recordId: newId(), kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', body: pdf(name) })
  return made.id
}

/** A file row of a record with pay figures (rows only: no module stores one by this route). */
async function payFile(): Promise<string> {
  const fileId = newId()
  await admin(
    `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storageKey", visibility, status, "availableAt", "storeAccountId", "createdAt", "updatedAt", "createdById")
     VALUES ($1, $2, $3, 'WorkerStatement', $4, 'DOCUMENT', 'Made-up statement.pdf', 'application/pdf', 100, $5, $6, ARRAY['OFFICE']::"FileAudience"[], 'AVAILABLE', now(), $7, now(), now(), $8)`,
    [fileId, T.tenant, T.companyA, newId(), 'a'.repeat(64), `t/${T.tenant}/c/${T.companyA}/2026/${fileId}`, T.store, T.actor],
  )
  return fileId
}

async function share(body: Json, session = 'sender', status = 201): Promise<Json> {
  const response = await call(session, 'POST', '/links/files', body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}

/** A link written straight into the database (a purpose no module makes yet): its token is minted here. */
async function plant(values: { purpose: string; recordType: string; expiresAt: Date; maxUses?: number }) {
  const linkId = newId()
  const token = mintLinkToken({ tenantId: T.tenant, partyId: T.P1, linkId })
  await admin(
    `INSERT INTO "OneOffLink" (id, "tenantId", "companyId", "partyId", purpose, "recordType", "recordId", "tokenHash", email, "expiresAt", "maxUses", "createdAt", "updatedAt", "createdById")
     VALUES ($1, $2, $3, $4, $5::"LinkPurpose", $6, $7, $8, $9, $10, $11, now(), now(), $12)`,
    [linkId, T.tenant, T.companyA, T.P1, values.purpose, values.recordType, newId(), linkTokenHash(token.value), BUYER, values.expiresAt, values.maxUses ?? 1, T.actor],
  )
  return { linkId, token: token.value }
}

beforeAll(async () => {
  db = await migratedDatabase('links_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedFiles({ db: database, namespace: NS })
  await seedParties({ db: database, namespace: NS })
  await seedEmail({ db: database, namespace: NS })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [T.tenant])
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-links-depth-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  const neverSes = sesMailAdapter({ clientFor: () => { throw new Error('This test never calls SES; its accounts are FAKE.') } })
  useEmail(createEmailRuntime({ gateway, fake: ses, webOrigin: WEB_ORIGIN, ses: neverSes, files: files.storage }))
  freshGuard()
  const limits = { max: 10_000, timeWindowMs: 60_000 }
  auth = createOfficeAuth({ database, environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET, pinPepper: LOCAL_PIN_PEPPER, webOrigin: WEB_ORIGIN, clock, mailer: { deliver: async () => {} }, rateLimits: { signIn: limits, resetRequest: limits, tokenUse: limits, codes: limits, linkUse: limits, floorSignIn: limits } })
  const links = linkAuthenticator({ database, clock })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, rateLimit: limits },
    { database, officeAuth: auth, clock, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => (carriesLink(request) ? links(request) : (SESSIONS[String(request.headers['x-test-session'])] ?? null))), logger: false },
  )
}, 300_000)

afterAll(async () => {
  useFiles(undefined)
  useEmail(undefined)
  useAbuseGuard(undefined)
  await app?.close()
  await connection?.quit()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('pay figures never go by link (Owner, 11-02)', () => {
  it('the API\'s list of pay records is the database\'s', async () => {
    const [row] = await admin<{ pay: string[] }>(`SELECT array_agg(t) FILTER (WHERE "factory_link_pay_record"(t)) AS pay FROM unnest($1::text[]) t`, [[...PAY_RECORD_TYPES, 'PayrollExport', 'Quote', 'StoredFile']])
    expect(row!.pay).toEqual([...PAY_RECORD_TYPES])
  })

  it('refuses a set that holds a file of a pay record, at its place, in words, and writes nothing', async () => {
    const doc = await storeFile('Made-up DoC for the pay test.pdf')
    const pay = await payFile()
    const refused = await share({ purpose: 'DOCUMENT_VIEW', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds: [doc, pay] }, 'sender', 409)
    expect(pathsOf(refused)).toEqual(['refusal/PAY_FIGURES', 'body/fileIds/1'])
    expect(refused.error.message).toBe('"Made-up statement.pdf" holds pay figures, and pay figures never go by link. Hand it over in person or in the office.')
    expect(await admin(`SELECT id FROM "OneOffLink" WHERE "recordId" = $1`, [doc])).toEqual([])
  })
})

describe('a secure file (SECURE_FILE; MES-274, links.file)', () => {
  let fileIds: string[]
  let linkId: string
  let token: string
  let unlock: string

  it('shares three files with a password, mails the link to the contact on file: never the password, and the link in no row', async () => {
    fileIds = [await storeFile('Made-up payroll hours October.csv'), await storeFile('Made-up summary October.pdf'), await storeFile('Made-up note.pdf')]
    const made = await share({ purpose: 'SECURE_FILE', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds, password: PASSWORD, send: true, language: 'en', note: 'Made-up note for the office' })
    expect(made).toMatchObject({ url: null, delivery: 'SENT' })
    expect(made.link).toMatchObject({ purpose: 'SECURE_FILE', recordType: 'StoredFile', recordId: fileIds[0], partyId: T.P1, email: BUYER, contactId: T.buyer, maxUses: 5, state: 'LIVE', password: { set: true, heldUntil: null }, receipt: null })
    expect(made.link.files.map((file: Json) => [file.position, file.fileId])).toEqual(fileIds.map((fileId, index) => [index + 1, fileId]))
    linkId = made.link.id
    expect(Math.round((new Date(made.link.expiresAt).getTime() - Date.now()) / 86_400_000)).toBe(7)
    const mail = mailsTo(BUYER).at(-1)!
    token = tokenOf(mail)
    const text = textOf(mail.raw)
    expect(text).toContain('- Made-up payroll hours October.csv')
    expect(text).toContain('we never send it with the link')
    expect(text).not.toContain(PASSWORD)
    const row = (await admin(`SELECT * FROM "OneOffLink" WHERE id = $1`, [linkId]))[0]!
    expect(row.passwordHash).toMatch(/^\$scrypt\$ln=15,r=8,p=3\$/)
    const stored = JSON.stringify(row) + JSON.stringify(await admin(`SELECT "after", reason FROM "AuditLog" WHERE "recordId" = $1`, [linkId])) + JSON.stringify(await admin(`SELECT * FROM "IdempotencyReceipt"`)) + JSON.stringify(await admin(`SELECT * FROM "EmailOutbound" WHERE "recordId" = $1`, [linkId]))
    expect(stored).not.toContain(token)
    expect(stored).not.toContain(PASSWORD)
  })

  it('refuses what may not go: another company\'s file, a file the person cannot read, no address, a short password, a purpose of no files', async () => {
    const otherCompany = await storeFile('Made-up file of company B.pdf', 'Style', T.companyB)
    const base = { purpose: 'SECURE_FILE', companyId: T.companyA, partyId: T.P1, contactId: T.buyer }
    expect(pathsOf(await share({ ...base, fileIds: [fileIds[0], otherCompany] }, 'sender', 400))).toEqual(['body/fileIds/1'])
    expect((await share({ ...base, fileIds: [fileIds[0]] }, 'noFiles', 400)).error.message).toBe('File not found.')
    expect(pathsOf(await share({ ...base, contactId: undefined, fileIds: [fileIds[0]] }, 'sender', 400))).toEqual(['body/contactId'])
    expect(pathsOf(await share({ ...base, fileIds: [fileIds[0]], password: 'short' }, 'sender', 400))).toEqual(['body/password'])
    expect((await call('sender', 'POST', '/links/files', { ...base, purpose: 'QUOTE_ACCEPT', fileIds: [fileIds[0]] })).statusCode).toBe(400)
    expect((await call('viewer', 'POST', '/links/files', { ...base, fileIds: [fileIds[0]] })).statusCode).toBe(403)
  })

  it('lists nothing but the count until the password, and opens without using the link', async () => {
    const page = await asLink(token, 'GET', '/link/files')
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json()).toMatchObject({ count: 3, files: [], link: { purpose: 'SECURE_FILE', usesLeft: 5, password: { asked: true, unlocked: false }, receipt: { asked: true, at: null } } })
    const opened = await asLink(token, 'POST', '/link/open', {})
    expect(opened.json().link).toMatchObject({ purpose: 'SECURE_FILE', usesLeft: 5, answers: [{ action: 'receive', typedName: 'optional' }] })
    const locked = await asLink(token, 'POST', `/link/files/${fileIds[0]}/download`, {})
    expect(locked.statusCode).toBe(403)
    expect(pathsOf(locked.json())).toEqual(['password'])
  })

  it('counts wrong passwords in words, holds the link at the fifth, and refuses even the right one while it holds', async () => {
    const other = await share({ purpose: 'SECURE_FILE', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds: [fileIds[2]!], password: PASSWORD })
    const heldToken = decodeURIComponent(other.url.split('#token=')[1])
    for (let left = 4; left >= 1; left -= 1) {
      const wrong = await asLink(heldToken, 'POST', '/link/password', { password: 'not the one' })
      expect(wrong.statusCode).toBe(400)
      expect(wrong.json().error.issues).toEqual([{ path: 'body/password', message: `That password does not match. ${left} ${left === 1 ? 'try' : 'tries'} left.` }])
    }
    const fifth = await asLink(heldToken, 'POST', '/link/password', { password: 'not the one' })
    expect(fifth.statusCode).toBe(429)
    expect(fifth.json().error.message).toBe('Too many wrong passwords. Try again in 15 minutes, or ask the sender.')
    expect(Number(fifth.headers['retry-after'])).toBeGreaterThan(800)
    const right = await asLink(heldToken, 'POST', '/link/password', { password: PASSWORD })
    expect(right.statusCode).toBe(429)
    const row = (await admin(`SELECT "passwordTries", "passwordHeldUntil" FROM "OneOffLink" WHERE id = $1`, [other.link.id]))[0]!
    expect(row.passwordTries).toBe(5)
    expect(new Date(row.passwordHeldUntil).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000)
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'links.passwordWrong' AND "recordId" = $1`, [other.link.id]))[0]!.n).toBe(5)
    expect((await call('viewer', 'GET', `/links?recordType=StoredFile&recordId=${fileIds[2]}`)).json().links[0].password).toMatchObject({ set: true, heldUntil: expect.any(String) })
    expect((await asLink(heldToken, 'GET', '/link/files')).json().link.password.heldUntil).not.toBeNull()
  })

  it('opens the files with the right password: names, sizes and checksums, never shown in the browser', async () => {
    const right = await asLink(token, 'POST', '/link/password', { password: PASSWORD })
    expect(right.statusCode, right.body).toBe(200)
    unlock = right.json().unlock
    expect(unlock).toMatch(/^lu1\./)
    const page = (await asLink(token, 'GET', '/link/files', undefined, unlock)).json()
    expect(page.link.password).toMatchObject({ asked: true, unlocked: true })
    expect(page.files.map((file: Json) => [file.position, file.name, file.preview, file.available, file.newer])).toEqual([
      [1, 'Made-up payroll hours October.csv', null, true, null],
      [2, 'Made-up summary October.pdf', null, true, null],
      [3, 'Made-up note.pdf', null, true, null],
    ])
    expect(page.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await asLink(token, 'GET', '/link/files', undefined, `${unlock.slice(0, -2)}xx`)).json().files).toEqual([])
    const preview = await asLink(token, 'GET', `/link/files/${fileIds[1]}/preview`, undefined, unlock)
    expect(preview.statusCode).toBe(409)
    expect(pathsOf(preview.json())).toEqual(['refusal/NO_PREVIEW'])
  })

  it('counts each download as a use, with its evidence and an audit row on the file; nothing outside the set', async () => {
    const got = await asLink(token, 'POST', `/link/files/${fileIds[0]}/download`, {}, unlock)
    expect(got.statusCode, got.body).toBe(200)
    expect(got.json()).toMatchObject({ fileId: fileIds[0], name: 'Made-up payroll hours October.csv', usesLeft: 4 })
    expect(got.json().download.url).toBeTruthy()
    expect(await admin(`SELECT action::text, "useNumber" FROM "LinkEvidence" WHERE "linkId" = $1 ORDER BY at`, [linkId])).toEqual([
      { action: 'OPENED', useNumber: null },
      { action: 'DOWNLOADED', useNumber: 1 },
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'links.downloadFile' AND "recordId" = $1`, [fileIds[0]]))[0]!.n).toBe(1)
    const event = (await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'link.used' AND payload->>'linkId' = $1 AND payload->>'action' = 'download'`, [linkId]))[0]!
    expect(event.payload).toMatchObject({ purpose: 'SECURE_FILE', counted: true })
    const outside = await storeFile('Made-up file not shared.pdf')
    expect((await asLink(token, 'POST', `/link/files/${outside}/download`, {}, unlock)).statusCode).toBe(404)
    expect((await asLink(token, 'GET', `/files/${fileIds[0]}`)).statusCode).toBe(403)
  })

  it('takes "I received these files" once, with the typed name, and the sender sees it', async () => {
    const received = await asLink(token, 'POST', '/link/files/received', { typedName: '  Studio  Made-up ' }, unlock)
    expect(received.statusCode, received.body).toBe(200)
    expect(received.json().receipt).toMatchObject({ name: 'Studio Made-up' })
    expect((await admin(`SELECT "useNumber", "typedName" FROM "LinkEvidence" WHERE "linkId" = $1 AND action = 'RECEIVED'`, [linkId]))).toEqual([{ useNumber: null, typedName: 'Studio Made-up' }])
    const again = await asLink(token, 'POST', '/link/files/received', {}, unlock)
    expect(again.statusCode).toBe(409)
    expect(pathsOf(again.json())).toEqual(['refusal/RECEIVED'])
    const listed = (await call('viewer', 'GET', `/links?recordType=StoredFile&recordId=${fileIds[0]}`)).json().links
    expect(listed[0]).toMatchObject({ id: linkId, uses: 1, receipt: { name: 'Studio Made-up' } })
    expect(listed[0].evidence.map((entry: Json) => entry.action)).toEqual(['OPENED', 'DOWNLOADED', 'RECEIVED'])
  })
})

describe('a set of documents (DOCUMENT_VIEW; COL-051, links.document)', () => {
  it('names a newer version of a shared file, shows a PDF in the page, and logs a download without using the link', async () => {
    const doc = await storeFile('Made-up DoC JKT-01 v3.pdf')
    const leaflet = await storeFile('Made-up care leaflet v1.pdf')
    const made = await share({ purpose: 'DOCUMENT_VIEW', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds: [doc, leaflet], expiresInDays: 30, maxUses: 10 })
    const token = decodeURIComponent(made.url.split('#token=')[1])
    // A second version of the leaflet replaces it afterwards (one transaction: the series never has two current versions).
    const v2 = newId()
    await admin('BEGIN')
    try {
      await admin(
        `INSERT INTO "StoredFile" (id, "tenantId", "companyId", "recordType", "recordId", kind, "originalName", "contentType", "sizeBytes", sha256, "storageKey", visibility, status, "availableAt", "storeAccountId", "createdAt", "updatedAt", "createdById", "seriesId", "versionNo")
         SELECT $1, "tenantId", "companyId", "recordType", "recordId", kind, 'Made-up care leaflet v2.pdf', "contentType", "sizeBytes", $2, $3, visibility, 'AVAILABLE', now(), "storeAccountId", now(), now(), "createdById", id, 2 FROM "StoredFile" WHERE id = $4`,
        [v2, 'b'.repeat(64), `t/${T.tenant}/c/${T.companyA}/2026/${v2}`, leaflet],
      )
      await admin(`UPDATE "StoredFile" SET "supersededAt" = now(), version = version + 1 WHERE id = $1`, [leaflet])
      await admin('COMMIT')
    } catch (error) {
      await admin('ROLLBACK')
      throw error
    }
    expect((await asLink(token, 'POST', '/link/open', {})).json().link.usesLeft).toBe(9)
    const page = (await asLink(token, 'GET', '/link/files')).json()
    expect(page.link.password).toEqual({ asked: false, unlocked: false, heldUntil: null })
    expect(page.files[0]).toMatchObject({ name: 'Made-up DoC JKT-01 v3.pdf', preview: 'inline', newer: null })
    expect(page.files[1].newer).toMatchObject({ versionNo: 2, sharedFileId: null, words: expect.stringMatching(/^Version 2 replaced this one on .+\. Ask the sender for it\.$/) })
    const preview = await asLink(token, 'GET', `/link/files/${doc}/preview`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ fileId: doc, mode: 'inline' })
    const got = await asLink(token, 'POST', `/link/files/${leaflet}/download`, {})
    expect(got.json()).toMatchObject({ usesLeft: 9 })
    expect(await admin(`SELECT action::text, "useNumber" FROM "LinkEvidence" WHERE "linkId" = $1 AND action = 'DOWNLOADED'`, [made.link.id])).toEqual([{ action: 'DOWNLOADED', useNumber: null }])
    expect((await asLink(token, 'POST', '/link/password', { password: 'anything at all' })).statusCode).toBe(409)
    expect((await asLink(token, 'POST', '/link/files/received', {})).statusCode).toBe(403)
  })
})

describe('ask for a new link (links.frame)', () => {
  let fileIds: string[]
  let old: Json
  let oldToken: string

  it('answers the same words at once, whatever the token', async () => {
    freshGuard()
    fileIds = [await storeFile('Made-up tech pack JKT-09.pdf'), await storeFile('Made-up size chart JKT-09.pdf')]
    old = await share({ purpose: 'SECURE_FILE', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds, password: PASSWORD, maxUses: 1, expiresInDays: 3, send: true, language: 'it' })
    oldToken = tokenOf(mailsTo(BUYER).at(-1)!)
    const live = await app.inject({ method: 'POST', url: '/link/renew', headers: { [LINK_HEADER]: oldToken }, payload: {} })
    const garbage = await app.inject({ method: 'POST', url: '/link/renew', headers: { [LINK_HEADER]: 'not a token' }, payload: {} })
    const none = await app.inject({ method: 'POST', url: '/link/renew', payload: {} })
    for (const answer of [live, garbage, none]) {
      expect(answer.statusCode).toBe(202)
      expect(answer.json()).toEqual({ status: 'requested', message: LINK_RENEW_ANSWER })
    }
    await auth.settled()
    // A link that still opens is not renewed.
    expect(await admin(`SELECT id FROM "OneOffLink" WHERE "renewalOfId" = $1`, [old.link.id])).toEqual([])
  })

  it('sends a new link of the same files, with the same password, to the address on file only, once', async () => {
    freshGuard()
    const unlock = (await asLink(oldToken, 'POST', '/link/password', { password: PASSWORD })).json().unlock
    expect((await asLink(oldToken, 'POST', `/link/files/${fileIds[0]}/download`, {}, unlock)).json().usesLeft).toBe(0)
    const dead = await asLink(oldToken, 'GET', '/link/files')
    expect(dead.statusCode).toBe(404)
    expect(dead.json().error.message).toBe(LINK_UNAVAILABLE)
    // A live share of another set of the same first file is another share: it does not stop the renewal.
    await share({ purpose: 'SECURE_FILE', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds: [fileIds[0]] })
    const before = mailsTo(BUYER).length
    expect((await app.inject({ method: 'POST', url: '/link/renew', headers: { [LINK_HEADER]: oldToken }, payload: {} })).statusCode).toBe(202)
    await auth.settled()
    const renewed = await admin(`SELECT * FROM "OneOffLink" WHERE "renewalOfId" = $1`, [old.link.id])
    expect(renewed).toHaveLength(1)
    const oldRow = (await admin(`SELECT "passwordHash" FROM "OneOffLink" WHERE id = $1`, [old.link.id]))[0]!
    expect(renewed[0]).toMatchObject({ purpose: 'SECURE_FILE', recordType: 'StoredFile', recordId: fileIds[0], partyId: T.P1, contactId: T.buyer, email: BUYER, maxUses: 1, passwordHash: oldRow.passwordHash, createdById: '00000000-0000-7000-8000-000000000000' })
    expect((await admin(`SELECT "fileId" FROM "LinkFile" WHERE "linkId" = $1 ORDER BY position`, [renewed[0]!.id])).map((row) => row.fileId)).toEqual(fileIds)
    expect(mailsTo(BUYER)).toHaveLength(before + 1)
    const mail = mailsTo(BUYER).at(-1)!
    expect(textOf(mail.raw)).toContain('Questo nuovo link sostituisce quello che non si apriva più.')
    const fresh = tokenOf(mail)
    const unlocked = await asLink(fresh, 'POST', '/link/password', { password: PASSWORD })
    expect(unlocked.statusCode, unlocked.body).toBe(200)
    expect((await asLink(fresh, 'GET', '/link/files', undefined, unlocked.json().unlock)).json().files).toHaveLength(2)
    const event = (await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'link.renewed' AND payload->>'renewalOfId' = $1`, [old.link.id]))[0]!
    expect(event.payload).toMatchObject({ linkId: renewed[0]!.id, purpose: 'SECURE_FILE', recordType: 'StoredFile' })
    // Asked again: a live link of these files went to that address already.
    await app.inject({ method: 'POST', url: '/link/renew', headers: { [LINK_HEADER]: oldToken }, payload: {} })
    await auth.settled()
    expect(await admin(`SELECT id FROM "OneOffLink" WHERE "renewalOfId" = $1`, [old.link.id])).toHaveLength(1)
    expect(mailsTo(BUYER)).toHaveLength(before + 1)
  })

  it('never renews a withdrawn link, and holds a token asked too often', async () => {
    freshGuard()
    const made = await share({ purpose: 'SECURE_FILE', companyId: T.companyA, partyId: T.P1, contactId: T.buyer, fileIds: [fileIds[1]!], expiresInDays: 1 })
    const token = decodeURIComponent(made.url.split('#token=')[1])
    expect((await call('sender', 'POST', `/links/${made.link.id}/revoke`, { reason: 'Made-up reason' })).statusCode).toBe(200)
    for (let i = 0; i < 3; i += 1) expect((await app.inject({ method: 'POST', url: '/link/renew', headers: { [LINK_HEADER]: token }, payload: {} })).statusCode).toBe(202)
    const held = await app.inject({ method: 'POST', url: '/link/renew', headers: { [LINK_HEADER]: token }, payload: {} })
    expect(held.statusCode).toBe(429)
    expect(pathsOf(held.json())).toEqual(['retryAfter'])
    await auth.settled()
    expect(await admin(`SELECT id FROM "OneOffLink" WHERE "renewalOfId" = $1`, [made.link.id])).toEqual([])
  })
})

describe('drafts kept with us (links.frame "Finish later")', () => {
  it('saves a sealed draft and resumes it from the same link, refuses a stale save, and counts no use', async () => {
    const { linkId, token } = await plant({ purpose: 'MEASUREMENTS', recordType: 'MeasurementProfile', expiresAt: new Date(Date.now() + 21 * 86_400_000) })
    expect((await asLink(token, 'GET', '/link/draft')).json()).toMatchObject({ draft: null })
    const first = await asLink(token, 'PUT', '/link/draft', { data: { chestCm: 102, note: 'made-up rider' } })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().draft).toMatchObject({ version: 1 })
    const second = await asLink(token, 'PUT', '/link/draft', { data: { chestCm: 103, note: 'made-up rider' }, version: 1 })
    expect(second.json().draft.version).toBe(2)
    expect((await asLink(token, 'PUT', '/link/draft', { data: { chestCm: 99 }, version: 1 })).statusCode).toBe(409)
    expect((await asLink(token, 'GET', '/link/draft')).json().draft).toMatchObject({ data: { chestCm: 103, note: 'made-up rider' }, version: 2 })
    const row = (await admin(`SELECT "dataEnc", "purgeAfter" FROM "LinkDraft" WHERE "linkId" = $1`, [linkId]))[0]!
    expect(row.dataEnc).toMatch(/^l1\./)
    expect(row.dataEnc).not.toContain('made-up rider')
    expect((await admin(`SELECT uses FROM "OneOffLink" WHERE id = $1`, [linkId]))[0]!.uses).toBe(0)
    expect(JSON.stringify(await admin(`SELECT * FROM "IdempotencyReceipt"`))).not.toContain('made-up rider')
  })

  it('keeps no draft for a link of another kind', async () => {
    const { token } = await plant({ purpose: 'APPROVAL', recordType: 'ApprovalRequest', expiresAt: new Date(Date.now() + 86_400_000) })
    expect((await asLink(token, 'PUT', '/link/draft', { data: { a: 1 } })).statusCode).toBe(403)
  })

  it('purges a draft 7 days after its link expired, not before', async () => {
    const expiresAt = new Date(Date.now() + 2 * 3_600_000)
    const { linkId, token } = await plant({ purpose: 'CLAIM', recordType: 'SalesOrder', expiresAt, maxUses: 5 })
    expect((await asLink(token, 'PUT', '/link/draft', { data: { reason: 'made-up stitching' } })).statusCode).toBe(200)
    const log = { info() {}, warn() {}, error() {} }
    await purgeLinkDrafts({ database, log, clock: { now: () => new Date(expiresAt.getTime() + 6 * 86_400_000) } })
    expect(await admin(`SELECT id FROM "LinkDraft" WHERE "linkId" = $1`, [linkId])).toHaveLength(1)
    expect(await purgeLinkDrafts({ database, log, clock: { now: () => new Date(expiresAt.getTime() + 7 * 86_400_000 + 1000) } })).toBeGreaterThanOrEqual(1)
    expect(await admin(`SELECT id FROM "LinkDraft" WHERE "linkId" = $1`, [linkId])).toEqual([])
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'links.purgeDrafts'`))[0]!.n).toBeGreaterThanOrEqual(1)
  })
})
