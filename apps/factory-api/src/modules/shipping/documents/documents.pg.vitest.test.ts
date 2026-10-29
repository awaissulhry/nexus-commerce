import { createHash, randomBytes } from 'node:crypto'
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
import { businessDate } from '@nexus/factory-domain/core/time'
import { linkTokenHash, mintLinkToken } from '@nexus/factory-domain/links/token'
import { RENEW_ANSWER } from '@nexus/factory-domain/shipping/documents/documents'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import type { ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { FakeSes, headerOf, textOf, type FakeMail } from '../../../adapters/ses/fake'
import { sesMailAdapter } from '../../../adapters/ses/ses'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import type { Clock } from '../../../core/time'
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { createOfficeAuth, type OfficeAuth } from '../../../platform/auth/sessions/office-auth'
import { createEmailRuntime, useEmail, type EmailRuntime } from '../../../platform/email-out/service'
import { storeGeneratedFile } from '../../../platform/files/files'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { carriesLink, LINK_HEADER, LINK_UNAVAILABLE, linkAuthenticator } from '../../../platform/links/authenticator'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { shipDocumentsHandler } from './handler'
import { shipmentDocumentBlockers, useShipmentDocumentsClock } from './read'

/**
 * The documents that travel with a shipment and the party's link to them (B-W1-49; PLAN §4.7 stage 14-ship "DoC by
 * link"; Reg. (EU) 2016/425 art. 8(8)) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database
 * from the migrations (the runtime login: row-level security — the partner role's wall for link sessions — and the
 * files and links guard triggers are real), the factory-db seeds of two tenants (the DRAFT SH-0002 of the serial-tracked
 * SEED-JKT-03; SEED-SO-0002's released SEED-JKT-02 garments), the local file store behind the seeded FAKE R2 account,
 * email out with the FAKE SES mailbox (the only place a link's token can be read), the real link authenticator and the
 * real office auth's after-the-answer work, on a clock the test moves. Every name, number and address is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs documents`.
 */

const WEB_ORIGIN = 'http://localhost:3200'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime
let email: EmailRuntime
let auth: OfficeAuth
let seedA: ShippingSeed
const ses = new FakeSes()

let current = Date.now()
const clock: Clock & { advance(ms: number): void } = { now: () => new Date(current), advance: (ms) => void (current += ms) }
const DAY = 24 * 60 * 60 * 1000

const ns = { a: 'shipdocs-a', b: 'shipdocs-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  P1: idOf(ns.a, 'party:P1'),
  P2: idOf(ns.a, 'party:P2'),
  buyer: idOf(ns.a, 'party-contact:P1:buyer'),
  operator: idOf(ns.a, 'worker:A1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }
const BUYER = 'buyer.p1@example.com'
const YEAR = businessDate(new Date()).slice(0, 4)

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant([...SHIPPING, 'files.read'])]),
  quality: office(A.tenant, [grant(['compliance.certificates.view', 'compliance.declarations.manage', 'files.read', 'files.upload'])]),
  viewer: office(A.tenant, [grant(['shipping.view', 'files.read'])]),
  companyB: office(A.tenant, [grant([...SHIPPING, 'files.read'], [A.companyB])]),
  otherTenant: office(B.tenant, [grant([...SHIPPING, 'files.read'])]),
  packerA1: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: ['shipping.pack'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `shipdocs-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]?.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': key() } : {}) },
    ...(payload === undefined ? {} : { payload: payload as object }),
  })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
/** A request of a link's holder: the token in x-factory-link (as the link page sends it from the fragment). */
const asLink = (token: string | undefined, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { ...(token === undefined ? {} : { [LINK_HEADER]: token }), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })

const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% made-up signed document: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const system = (tenantId = A.tenant) => callerFor(database, systemContext(tenantId, newId()))
const documentsUrl = (shipmentId: string) => `/shipping/shipments/${shipmentId}/documents`

/** The Owner's three steps on the style's Compliance tab: announce the signed PDF, send it, confirm it. */
async function uploadDoc(styleId: string, revisionId: string, kind: string, language: string, body: Buffer): Promise<Json> {
  const announced = await ok(
    'quality',
    'POST',
    `/product/styles/${styleId}/compliance/documents`,
    { revisionId, kind, language, originalName: `${kind.toLowerCase()}-${language}.pdf`, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) },
    201,
  )
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  await ok('quality', 'POST', `/product/styles/${styleId}/compliance/documents/${announced.document.id}/files/${announced.file.id}/complete`)
  return announced.file
}

/** Runs the worker's handler for the goods leaving, with the event the ship command wrote. */
async function shipped(shipmentId: string): Promise<void> {
  const [event] = await admin<{ id: string; payload: Json }>(
    `SELECT id, payload FROM "OutboxEvent" WHERE type = 'shipment.status_changed' AND subject = $1 AND payload->>'to' = 'SHIPPED' ORDER BY "occurredAt" DESC LIMIT 1`,
    [shipmentId],
  )
  expect(event, 'the ship command wrote its event').toBeDefined()
  await shipDocumentsHandler({ files: () => files, email: () => email }).handle({ eventId: event!.id, type: 'shipment.status_changed', version: 1, tenantId: A.tenant, payload: event!.payload } as never, {
    caller: system(),
    attempt: 1,
  })
}

const mailsTo = (address: string): FakeMail[] => ses.mails.filter((mail) => mail.to.includes(address))
const tokenOf = (mail: FakeMail): string => decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))![1]!)
const shipmentFiles = (shipmentId: string) =>
  admin<{ id: string; sha256: string; kind: string; visibility: string[]; partyId: string | null; retainUntil: Date | null; originalName: string }>(
    `SELECT id, sha256, kind::text AS kind, visibility::text[] AS visibility, "partyId", "retainUntil", "originalName" FROM "StoredFile" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND visibility @> ARRAY['LINK']::"FileAudience"[] ORDER BY "createdAt", id`,
    [shipmentId],
  )
const linksOf = (shipmentId: string) =>
  admin<{ id: string; email: string; revokedAt: Date | null; expiresAt: Date; maxUses: number; uses: number; createdById: string; partyId: string }>(
    `SELECT id, email, "revokedAt", "expiresAt", "maxUses", uses, "createdById", "partyId" FROM "OneOffLink" WHERE "recordType" = 'Shipment' AND "recordId" = $1 ORDER BY "createdAt", id`,
    [shipmentId],
  )
const addYears = (date: Date, years: number) => {
  const next = new Date(date.getTime())
  next.setUTCFullYear(next.getUTCFullYear() + years)
  return next
}

beforeAll(async () => {
  db = await migratedDatabase('ship_documents')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seedA = (await seedMoney({ db: database, namespace: ns.a })).shipping
  await seedMoney({ db: database, namespace: ns.b })
  for (const namespace of [ns.a, ns.b]) await seedEmail({ db: database, namespace })
  for (const [tenantId, companyId] of [
    [A.tenant, A.companyA],
    [B.tenant, B.companyA],
  ] as const) {
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
    await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [tenantId])
    // A test copies and mails more than the seeded accounts' default bursts (production settings) allow.
    await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider IN ('R2', 'SES')`, [tenantId])
  }

  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-ship-documents-test-'))
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  const neverSes = sesMailAdapter({
    clientFor: () => {
      throw new Error('This test never calls SES; its accounts are FAKE.')
    },
  })
  email = createEmailRuntime({ gateway, fake: ses, webOrigin: WEB_ORIGIN, ses: neverSes, files: files.storage })
  useEmail(email)
  useShipmentDocumentsClock(clock)
  const limits = { max: 10_000, timeWindowMs: 60_000 }
  auth = createOfficeAuth({
    database,
    environment: 'test',
    cookieSecret: LOCAL_COOKIE_SECRET,
    pinPepper: LOCAL_PIN_PEPPER,
    webOrigin: WEB_ORIGIN,
    clock,
    mailer: { deliver: async () => {} },
    rateLimits: { signIn: limits, resetRequest: limits, tokenUse: limits, codes: limits, linkUse: limits, floorSignIn: limits },
  })
  const links = linkAuthenticator({ database, clock })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, webOrigin: WEB_ORIGIN, rateLimit: limits },
    {
      database,
      officeAuth: auth,
      clock,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      // The real link authenticator for a link's token; the test's office and floor sessions otherwise.
      authenticate: testAuthenticator((request) => (carriesLink(request) ? links(request) : (SESSIONS[String(request.headers['x-test-session'])] ?? null))),
      logger: false,
    },
  )
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  useEmail(undefined)
  useShipmentDocumentsClock(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

// SH-0002 (seeded DRAFT, SEED-JKT-03 revision 1 of SO-0003): two garments in two parcels; then SB (SEED-JKT-02, WO-0001
// frozen at revision 1, while the style has a revision 2 with its own DoC).
const sh2 = () => seedA.draftShipmentId
const S: Record<string, string> = {}
const BODY = {
  jkt3DocIt: pdf('SEED-JKT-03 DoC r1 it'),
  jkt3DocEn: pdf('SEED-JKT-03 DoC r1 en'),
  jkt3LeafletEn: pdf('SEED-JKT-03 leaflet r1 en'),
  jkt2DocR1: pdf('SEED-JKT-02 DoC r1 it'),
  jkt2LeafletR1: pdf('SEED-JKT-02 leaflet r1 it'),
  jkt2DocR2: pdf('SEED-JKT-02 DoC r2 it'),
}

describe('the documents of a packed shipment (LOG-020)', () => {
  it('packs SH-0002 into two parcels with a serial each', async () => {
    const [, second, third] = seedA.quality.serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial]))
    const added = (await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/lines`, { lines: [{ workOrderSizeId: seedA.quality.serialCellId, quantity: 1 }] })).shipment
    S.p1 = seedA.draftParcelId
    S.p2 = (await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/parcels`, {}, 201)).parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await ok('warehouse', 'PUT', `/shipping/packing/${sh2()}/lines/${loose.id}/parcel`, { parcelId: S.p2 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[second!], parcelId: S.p1 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[third!], parcelId: S.p2 })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p1}`, { grossWeightKg: '1.85' })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '1.90' })
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment.status).toBe('PACKED')
  })

  it('names what is missing: no DDT yet, and no DoC or leaflet of SEED-JKT-03 revision 1, which blocks shipping in words', async () => {
    const { documents } = await ok('warehouse', 'GET', documentsUrl(sh2()))
    expect(documents.languages).toEqual(['it', 'en'])
    expect(documents.documents.map((document: Json) => [document.kind, document.state, document.style?.code ?? null, document.style?.revision ?? null])).toEqual([
      ['DDT', 'MISSING', null, null],
      ['DECLARATION_OF_CONFORMITY', 'MISSING', 'SEED-JKT-03', 1],
      ['USER_INFORMATION', 'MISSING', 'SEED-JKT-03', 1],
      ['PACKING_LIST', 'MISSING', null, null],
    ])
    expect(documents.blockers.map((check: Json) => [check.code, check.state, check.blocks])).toEqual([
      ['DECLARATION_OF_CONFORMITY', 'BLOCKED', ['SHIPPING']],
      ['USER_INFORMATION', 'BLOCKED', ['SHIPPING']],
    ])
    expect(documents.blockers[0].problems).toEqual([
      {
        path: 'documents/DECLARATION_OF_CONFORMITY/SEED-JKT-03',
        message: 'No signed EU Declaration of Conformity of SEED-JKT-03 for revision 1 is on file in it or en: PPE is shipped only with it (Reg. (EU) 2016/425 art. 8(8), art. 15).',
      },
    ])
    expect(documents.recipients).toEqual([{ contactId: A.buyer, name: 'Seed Buyer One', email: BUYER }])
    // The ship step's question, inside its own transaction: the same blockers.
    const blockers = await system().withClient((client) => shipmentDocumentBlockers(client, sh2()))
    expect(blockers.map((check) => check.code)).toEqual(['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'])
  })

  it('keeps the documents to the office: a viewer reads but never attaches or mails; another company or tenant finds nothing', async () => {
    expect((await refused('viewer', 'POST', `${documentsUrl(sh2())}/attach`, {}, 403)).code).toBe('forbidden')
    expect((await refused('viewer', 'POST', `${documentsUrl(sh2())}/link`, {}, 403)).code).toBe('forbidden')
    for (const session of ['companyB', 'otherTenant']) {
      expect((await refused(session, 'GET', documentsUrl(sh2()), undefined, 404)).code).toBe('not_found')
      expect((await refused(session, 'POST', `${documentsUrl(sh2())}/attach`, {}, 404)).code).toBe('not_found')
      expect((await refused(session, 'POST', `${documentsUrl(sh2())}/link`, {}, 404)).code).toBe('not_found')
    }
    expect((await refused('packerA1', 'GET', documentsUrl(sh2()), undefined, 403)).code).toBe('forbidden')
  })

  it('refuses to let the goods leave without them (409 in the compliance step\'s words, no number used), but issues the DDT', async () => {
    const numbers = async () => (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "NumberAllocation" WHERE "recordType" = 'Ddt'`))[0]!.n
    const before = await numbers()
    const shipNow = await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, { ship: true }, 409)
    expect(shipNow.code).toBe('invalid_state')
    expect(shipNow.message).toBe(
      'The EU Declaration of Conformity is not on file for SEED-JKT-03 revision 1 (Reg. (EU) 2016/425 art. 8(8), art. 15): PPE is shipped only with it. ' +
        'The user information leaflet is not on file for SEED-JKT-03 revision 1 (Reg. (EU) 2016/425 art. 8(7), Annex II 1.4): PPE is shipped only with it.',
    )
    expect(await numbers()).toBe(before)
    expect(await admin('SELECT id FROM "Ddt" WHERE "shipmentId" = $1', [sh2()])).toEqual([])
    // The DDT alone (the goods stay PACKED) never asks for them.
    const issued = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 201)
    expect(issued.shipment.status).toBe('PACKED')
    expect(await numbers()).toBe(before + 1)
    S.ddtFile = issued.file.id
    S.ddtNumber = issued.ddt.number
    const handOver = await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/ship`, {}, 409)
    expect(handOver).toMatchObject({ code: 'invalid_state', message: shipNow.message })
    expect((await admin<{ status: string }>('SELECT status::text AS status FROM "Shipment" WHERE id = $1', [sh2()]))[0]!.status).toBe('PACKED')
  })

  it('takes the DoC in the buyer\'s language and the leaflet in its fallback once they are on file (a warning, no blocker)', async () => {
    await uploadDoc(seedA.quality.serialStyleId, seedA.quality.serialRevisionId, 'DECLARATION_OF_CONFORMITY', 'en', BODY.jkt3DocEn)
    await uploadDoc(seedA.quality.serialStyleId, seedA.quality.serialRevisionId, 'DECLARATION_OF_CONFORMITY', 'it', BODY.jkt3DocIt)
    await uploadDoc(seedA.quality.serialStyleId, seedA.quality.serialRevisionId, 'USER_INFORMATION', 'en', BODY.jkt3LeafletEn)
    const { documents } = await ok('warehouse', 'GET', documentsUrl(sh2()))
    const [, doc, leaflet] = documents.documents
    expect(doc).toMatchObject({ state: 'ON_FILE', language: 'it', fallback: false, source: { sha256: sha(BODY.jkt3DocIt) } })
    expect(leaflet).toMatchObject({ state: 'ON_FILE', language: 'en', fallback: true, wantedLanguage: 'it', source: { sha256: sha(BODY.jkt3LeafletEn) } })
    expect(documents.blockers).toEqual([])
    expect(documents.warnings).toEqual([expect.objectContaining({ path: 'documents/USER_INFORMATION/SEED-JKT-03' })])
    expect(await system().withClient((client) => shipmentDocumentBlockers(client, sh2()))).toEqual([])
  })
})

describe('when the goods leave (the worker attaches the documents and mails the link)', () => {
  it('hands SH-0002 over once they are on file, then copies the DDT, the DoC and the leaflet onto it for its party, kept ten years', async () => {
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ship`, {})).shipment.status).toBe('SHIPPED')
    const ddtPdf = (await admin<{ sha256: string; id: string }>('SELECT id, sha256 FROM "StoredFile" WHERE id = $1', [S.ddtFile]))[0]!
    await shipped(sh2())

    const [shipment] = await admin<{ shippedAt: Date }>('SELECT "shippedAt" FROM "Shipment" WHERE id = $1', [sh2()])
    const keep = addYears(shipment!.shippedAt, 10)
    const copies = await shipmentFiles(sh2())
    expect(copies.map((file) => file.sha256).sort()).toEqual([ddtPdf.sha256, sha(BODY.jkt3DocIt), sha(BODY.jkt3LeafletEn)].sort())
    for (const file of copies) expect(file).toMatchObject({ kind: 'DOCUMENT', visibility: ['OFFICE', 'PARTNER', 'LINK'], partyId: A.P1, retainUntil: keep })
    expect(copies.map((file) => file.originalName).sort()).toEqual([
      `DDT ${S.ddtNumber!.replace('/', '-')}.pdf`,
      'EU Declaration of Conformity, SEED-JKT-03 revision 1 (it).pdf',
      'User information, SEED-JKT-03 revision 1 (en).pdf',
    ])
    // The sources are kept as long: the signed DoC and leaflet (their style's files, office only) and the DDT's PDF.
    const sources = await admin<{ sha256: string; retainUntil: Date; visibility: string[] }>(
      `SELECT sha256, "retainUntil", visibility::text[] AS visibility FROM "StoredFile" WHERE sha256 = ANY($1::text[]) AND "recordType" <> 'Shipment'`,
      [[sha(BODY.jkt3DocIt), sha(BODY.jkt3LeafletEn), ddtPdf.sha256]],
    )
    expect(sources).toHaveLength(3)
    for (const source of sources) expect(source.retainUntil.getTime()).toBeGreaterThanOrEqual(keep.getTime())
    expect(sources.find((source) => source.sha256 === sha(BODY.jkt3DocIt))!.visibility).toEqual(['OFFICE'])
    const audit = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND action = 'shipping.attachDocuments'`, [sh2()])
    expect(audit).toEqual([{ action: 'shipping.attachDocuments', after: expect.objectContaining({ attached: 3, retained: 3, missing: 1 }) }])
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.documents_attached' AND subject = $1`, [sh2()])).toEqual([{ n: 1 }])
  })

  it('mails the buyer a link on the shipment\'s thread: the token in the mail only, never in a row, an event or a receipt', async () => {
    const [link] = await linksOf(sh2())
    expect(link).toMatchObject({ email: BUYER, revokedAt: null, maxUses: 100, uses: 0, createdById: SYSTEM_ACTOR_ID, partyId: A.P1 })
    expect(Math.round((link!.expiresAt.getTime() - clock.now().getTime()) / DAY)).toBe(365)
    const [mail] = mailsTo(BUYER)
    expect(mail).toBeDefined()
    const text = textOf(mail!.raw)
    const token = tokenOf(mail!)
    expect(text).toContain(`${WEB_ORIGIN}/l#token=`)
    expect(text).toMatch(/- EU Declaration of Conformity, SEED-JKT-03 rev\. 1 \(it\)|- Dichiarazione UE di conformità, SEED-JKT-03 rev\. 1 \(it\)/)
    expect(headerOf(mail!.raw, 'Reply-To')).toMatch(/^r-[a-z2-7]{26}@reply\./)
    expect(headerOf(mail!.raw, 'Auto-Submitted')).toBe('auto-generated')
    expect(linkTokenHash(token)).toBe((await admin<{ tokenHash: string }>('SELECT "tokenHash" FROM "OneOffLink" WHERE id = $1', [link!.id]))[0]!.tokenHash)

    const [outbound] = await admin<{ status: string; messageId: string; threadId: string }>(`SELECT status::text AS status, "messageId", "threadId" FROM "EmailOutbound" WHERE "recordType" = 'Shipment' AND "recordId" = $1`, [sh2()])
    expect(outbound!.status).toBe('SENT')
    const [message] = await admin<{ bodyText: string; partyId: string; direction: string }>('SELECT "bodyText", "partyId", direction::text AS direction FROM "Message" WHERE id = $1', [outbound!.messageId])
    expect(message).toMatchObject({ partyId: A.P1, direction: 'OUTBOUND' })
    expect(message!.bodyText).toContain('[Link personale inviato solo per e-mail: non è conservato qui.]')
    // The worker never sends this mail from its stored text: no email.queued for it.
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'email.queued' AND payload->>'threadId' = $1`, [outbound!.threadId])).toEqual([{ n: 0 }])
    const secret = token.split('.').at(-1)!
    for (const [table, column] of [
      ['Message', '"bodyText"'],
      ['AuditLog', 'after::text'],
      ['OutboxEvent', 'payload::text'],
      ['IdempotencyReceipt', 'response::text'],
      ['EmailOutbound', 'subject'],
      ['OneOffLink', 'note'],
    ] as const) {
      expect(await admin(`SELECT count(*)::int AS n FROM "${table}" WHERE ${column} LIKE $1`, [`%${secret}%`]), table).toEqual([{ n: 0 }])
    }
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.documents_link_sent' AND subject = $1 AND payload->>'reason' = 'SHIPPED'`, [sh2()])).toEqual([{ n: 1 }])
    S.token1 = token
  })

  it('does it once: the same event again, and the office\'s attach, copy and mail nothing more', async () => {
    const before = { files: (await shipmentFiles(sh2())).length, links: (await linksOf(sh2())).length, mails: ses.mails.length }
    await shipped(sh2())
    const again = await ok('warehouse', 'POST', `${documentsUrl(sh2())}/attach`, {})
    expect(again).toMatchObject({ attached: 0, retained: 0 })
    expect(again.documents.counts).toEqual({ attached: 3, toAttach: 0, missing: 1 })
    expect(again.documents.documents.map((document: Json) => document.state)).toEqual(['ATTACHED', 'ATTACHED', 'ATTACHED', 'MISSING'])
    expect(again.documents.links).toEqual([expect.objectContaining({ email: BUYER, state: 'LIVE', automatic: true, uses: 0 })])
    expect({ files: (await shipmentFiles(sh2())).length, links: (await linksOf(sh2())).length, mails: ses.mails.length }).toEqual(before)
  })
})

describe('the party opens its link (SCR-101)', () => {
  it('lists exactly the shipment\'s shared documents, and opening it twice does not use it up', async () => {
    for (let open = 1; open <= 2; open++) {
      const opened = await asLink(S.token1, 'POST', '/link/open', {}, key())
      expect(opened.statusCode, opened.body).toBe(200)
      expect(opened.json().link).toMatchObject({ purpose: 'DOCUMENT_VIEW', record: { type: 'Shipment', id: sh2() }, usesLeft: 100 - open })
    }
    const listed = await asLink(S.token1, 'GET', '/shipping/link/documents')
    expect(listed.statusCode, listed.body).toBe(200)
    const body = listed.json()
    expect(body.link.usesLeft).toBe(98)
    expect(body.shipment).toMatchObject({ number: expect.any(String), status: 'SHIPPED', shippedAt: expect.any(String) })
    expect(body.documents.map((document: Json) => [document.kind, document.title])).toEqual([
      ['DDT', expect.stringMatching(/^DDT \d+\/\d{4}$/)],
      ['DECLARATION_OF_CONFORMITY', 'EU Declaration of Conformity, SEED-JKT-03 revision 1 (it)'],
      ['USER_INFORMATION', 'User information, SEED-JKT-03 revision 1 (en)'],
    ])
    expect(body.documents.map((document: Json) => document.fileId).sort()).toEqual((await shipmentFiles(sh2())).map((file) => file.id).sort())
    // Reading never uses the link; it is still live.
    expect((await linksOf(sh2()))[0]).toMatchObject({ uses: 2, revokedAt: null })
    S.docFile = body.documents[1].fileId
  })

  it('downloads a document (logged), the same bytes as the signed DoC', async () => {
    const answer = await asLink(S.token1, 'POST', `/shipping/link/documents/${S.docFile}/download`, {}, key())
    expect(answer.statusCode, answer.body).toBe(200)
    const got = await app.inject({ method: 'GET', url: answer.json().download.url })
    expect(got.rawPayload.equals(BODY.jkt3DocIt)).toBe(true)
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'shipping.downloadDocument' AND "recordId" = $1`, [S.docFile])).toEqual([{ n: 1 }])
    // A link write needs an Idempotency-Key (a link may be clicked twice).
    expect((await asLink(S.token1, 'POST', `/shipping/link/documents/${S.docFile}/download`, {})).statusCode).toBe(400)
  })

  it('never shows a carrier label, the packing list, an office file or a file shared with another party', async () => {
    const make = (recordType: string, recordId: string, name: string, sharing: Json) =>
      storeGeneratedFile(files, system(), { companyId: A.companyA, recordType, recordId, kind: 'DOCUMENT', originalName: name, contentType: 'application/pdf', body: pdf(name), ...sharing })
    const label = await make('Parcel', S.p1!, 'label.pdf', { visibility: ['FLOOR'], floorSiteId: A.siteA1 })
    const packing = await make('Shipment', sh2(), 'packing list.pdf', { visibility: ['FLOOR'], floorSiteId: A.siteA1 })
    const internal = await make('Shipment', sh2(), 'internal.pdf', {})
    const otherParty = await make('Shipment', sh2(), 'for P2.pdf', { visibility: ['LINK'], partyId: A.P2 })
    const listed = (await asLink(S.token1, 'GET', '/shipping/link/documents')).json().documents.map((document: Json) => document.fileId)
    expect(listed).toHaveLength(3)
    for (const file of [label, packing, internal, otherParty]) {
      expect(listed).not.toContain(file.id)
      expect((await asLink(S.token1, 'POST', `/shipping/link/documents/${file.id}/download`, {}, key())).statusCode).toBe(404)
      // The files platform's own routes agree (the link reads files: DOCUMENT_VIEW holds files.read).
      expect((await asLink(S.token1, 'GET', `/files/${file.id}/download`)).statusCode).toBe(404)
    }
    expect((await asLink(S.token1, 'GET', `/files?recordType=Parcel&recordId=${S.p1}`)).json().files).toEqual([])
    expect((await asLink(S.token1, 'GET', `/files?recordType=Shipment&recordId=${sh2()}`)).json().files.map((file: Json) => file.id).sort()).toEqual([...listed].sort())
    // The office sees the packing list as printed (it travels in the parcels, not by the link).
    const { documents } = await ok('warehouse', 'GET', documentsUrl(sh2()))
    expect(documents.documents.at(-1)).toMatchObject({ kind: 'PACKING_LIST', state: 'ON_FILE', byLink: false })
  })

  it('another party\'s link sees nothing of it, even one made at the database level for this very shipment', async () => {
    const linkId = newId()
    const forged = mintLinkToken({ tenantId: A.tenant, partyId: A.P2, linkId })
    await admin(
      `INSERT INTO "OneOffLink" (id, "tenantId", "companyId", "partyId", purpose, "recordType", "recordId", "tokenHash", email, "expiresAt", "maxUses", "createdById") VALUES ($1, $2, $3, $4, 'DOCUMENT_VIEW', 'Shipment', $5, $6, 'orders.p2@example.com', $7, 100, $8)`,
      [linkId, A.tenant, A.companyA, A.P2, sh2(), linkTokenHash(forged.value), new Date(clock.now().getTime() + 30 * DAY), SYSTEM_ACTOR_ID],
    )
    const listed = await asLink(forged.value, 'GET', '/shipping/link/documents')
    expect(listed.statusCode).toBe(404)
    expect(listed.json().error.message).toBe(LINK_UNAVAILABLE)
    for (const file of await shipmentFiles(sh2())) {
      if (file.partyId !== A.P1) continue
      expect((await asLink(forged.value, 'POST', `/shipping/link/documents/${file.id}/download`, {}, key())).statusCode).toBe(404)
      expect((await asLink(forged.value, 'GET', `/files/${file.id}/download`)).statusCode).toBe(404)
    }
    const generic = (await asLink(forged.value, 'GET', `/files?recordType=Shipment&recordId=${sh2()}`)).json().files
    expect(generic.every((file: Json) => file.partyId === A.P2)).toBe(true)
    // A link of another tenant's party finds nothing either.
    const stranger = mintLinkToken({ tenantId: B.tenant, partyId: idOf(ns.b, 'party:P1'), linkId: newId() }).value
    expect((await asLink(stranger, 'GET', '/shipping/link/documents')).json().error.message).toBe(LINK_UNAVAILABLE)
  })
})

describe('the frozen revision (a style revised after the work order was released)', () => {
  it('sends the DoC of the work order\'s revision 1 with SEED-JKT-02, not the newer revision 2\'s', async () => {
    const production = seedA.quality.production
    const rev2 = newId()
    await admin(`INSERT INTO "StyleRevision" (id, "tenantId", "styleId", revision, status, "labelTemplateId", "changeNote") VALUES ($1, $2, $3, 2, 'DRAFT', $4, 'A made-up second revision.')`, [
      rev2,
      A.tenant,
      production.styleId,
      production.labelTemplateId,
    ])
    await uploadDoc(production.styleId, production.revisionId, 'DECLARATION_OF_CONFORMITY', 'it', BODY.jkt2DocR1)
    await uploadDoc(production.styleId, production.revisionId, 'USER_INFORMATION', 'it', BODY.jkt2LeafletR1)
    await uploadDoc(production.styleId, rev2, 'DECLARATION_OF_CONFORMITY', 'it', BODY.jkt2DocR2)
    expect(await admin(`SELECT revision, status::text AS status FROM "ComplianceDocument" WHERE "styleId" = $1 AND kind = 'DECLARATION_OF_CONFORMITY' AND language = 'it' ORDER BY revision`, [production.styleId])).toEqual([
      { revision: 1, status: 'SUPERSEDED' },
      { revision: 2, status: 'ISSUED' },
    ])

    const sb = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: production.salesOrderId, lines: [{ workOrderSizeId: production.cellIds['BLK-52'], quantity: 1 }] }, 201)).shipment
    S.sb = sb.id
    const parcel = (await ok('warehouse', 'POST', `/shipping/packing/${sb.id}/parcels`, { grossWeightKg: '2.5' }, 201)).parcelId
    await ok('warehouse', 'PUT', `/shipping/packing/${sb.id}/lines/${sb.lines[0].id}/parcel`, { parcelId: parcel })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${sb.id}/pack`, {})).shipment.status).toBe('PACKED')
    // The DDT issued and the goods shipped at once: allowed, SEED-JKT-02 revision 1's DoC and leaflet are on file.
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sb.id}/ddt`, { ship: true }, 201)).shipment.status).toBe('SHIPPED')
    await shipped(sb.id)

    const copies = (await shipmentFiles(sb.id)).map((file) => file.sha256)
    expect(copies).toContain(sha(BODY.jkt2DocR1))
    expect(copies).toContain(sha(BODY.jkt2LeafletR1))
    expect(copies).not.toContain(sha(BODY.jkt2DocR2))
    const { documents } = await ok('warehouse', 'GET', documentsUrl(sb.id))
    expect(documents.documents[1]).toMatchObject({ kind: 'DECLARATION_OF_CONFORMITY', state: 'ATTACHED', style: { code: 'SEED-JKT-02', revision: 1 } })
  })
})

describe('a link that no longer opens (ask for a new link)', () => {
  it('the office sends a new link (it replaces the older live one); its answer holds no token', async () => {
    const sent = await call('warehouse', 'POST', `${documentsUrl(sh2())}/link`, { expiresInDays: 1 })
    expect(sent.statusCode, sent.body).toBe(201)
    const body = sent.json()
    expect(body.links).toEqual([expect.objectContaining({ email: BUYER, maxUses: 100, delivery: 'SENT' })])
    expect(sent.body).not.toContain('#token=')
    const [first, second] = await linksOf(sh2())
    expect(first).toMatchObject({ revokedAt: expect.any(Date) })
    expect(second).toMatchObject({ email: BUYER, revokedAt: null })
    expect((await asLink(S.token1, 'GET', '/shipping/link/documents')).statusCode).toBe(404)
    const mail = mailsTo(BUYER).at(-1)!
    S.token2 = tokenOf(mail)
    expect(S.token2).not.toBe(S.token1)
    expect((await asLink(S.token2, 'GET', '/shipping/link/documents')).statusCode).toBe(200)
  })

  it('an expired link answers the one end state, and asking again answers the same whatever the token', async () => {
    clock.advance(2 * DAY)
    const expired = await asLink(S.token2, 'GET', '/shipping/link/documents')
    const garbage = await asLink('not-a-token', 'GET', '/shipping/link/documents')
    expect([expired.statusCode, garbage.statusCode]).toEqual([404, 404])
    expect(expired.json().error.message).toBe(garbage.json().error.message)

    const mails = ses.mails.length
    const answers = [
      await asLink(S.token2, 'POST', '/shipping/link/renew', {}),
      await asLink('not-a-token', 'POST', '/shipping/link/renew', {}),
      await asLink(undefined, 'POST', '/shipping/link/renew', {}),
      await asLink(S.token1, 'POST', '/shipping/link/renew', {}),
    ]
    for (const answer of answers) {
      expect(answer.statusCode, answer.body).toBe(202)
      expect(answer.json()).toEqual({ status: 'requested', message: RENEW_ANSWER })
    }
    await auth.settled()
    // Only the expired link of an address on file got a new one; the withdrawn one (token 1) and the garbage nothing.
    expect(ses.mails.slice(mails).map((mail) => mail.to)).toEqual([[BUYER]])
    const renewed = ses.mails.at(-1)!
    expect(textOf(renewed.raw)).toContain('come richiesto, ecco un nuovo link')
    const token3 = tokenOf(renewed)
    expect((await asLink(token3, 'GET', '/shipping/link/documents')).json().documents).toHaveLength(3)
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.documents_link_sent' AND subject = $1 AND payload->>'reason' = 'ASKED_AGAIN'`, [sh2()])).toEqual([{ n: 1 }])
    S.token3 = token3
  })

  it('makes no second link within ten minutes, and none for an address no longer on file', async () => {
    const mails = ses.mails.length
    await asLink(S.token2, 'POST', '/shipping/link/renew', {})
    await auth.settled()
    expect(ses.mails.length).toBe(mails)

    clock.advance(366 * DAY)
    expect((await asLink(S.token3, 'GET', '/shipping/link/documents')).statusCode).toBe(404)
    await admin(`UPDATE "PartyContact" SET status = 'ARCHIVED' WHERE id = $1`, [A.buyer])
    const answer = await asLink(S.token3, 'POST', '/shipping/link/renew', {})
    expect(answer.statusCode).toBe(202)
    await auth.settled()
    expect(ses.mails.length).toBe(mails)
    await admin(`UPDATE "PartyContact" SET status = 'ACTIVE' WHERE id = $1`, [A.buyer])
    // The address is on file again: a new link goes to it (and only to it).
    await asLink(S.token3, 'POST', '/shipping/link/renew', {})
    await auth.settled()
    expect(ses.mails.slice(mails).map((mail) => mail.to)).toEqual([[BUYER]])
  })
})
