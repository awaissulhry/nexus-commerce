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
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import type { ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { FakeSendcloud } from '../../../adapters/sendcloud/fake'
import { sendcloudAdapter } from '../../../adapters/sendcloud/sendcloud'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService, type SecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../documents/testing/compliance'
import { createCarrierRuntime, useCarrier } from '../labels/carrier'
import { pdfText } from '../../../platform/documents/testing/pdf-text'
import { pdfPages } from './pdf-merge'

/**
 * Labels and documents (B-W2b-391; LOG-027, LOG-031, LOG-058) on the local stack with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants and B-W2b-367's
 * …_carriers_w2b_guards are real: a reprint's original and reason, a proforma's number), the factory-db seeds up to money (the
 * DRAFT SH-0002 of the serial-tracked jacket, its order, the company's PROFORMA series), company A's FAKE Sendcloud account, the
 * local file store, sessions from the test authenticator. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/shipping/shipment-pack`.
 *
 *   setup      SH-0002 packed into two weighed parcels, its DDT issued, its two labels bought (PDF and ZPL) and printed (W1);
 *              site A1 stays in test mode (B-W2b-390): the labels are TEST labels, and every path here says TEST
 *   reprint    a packer prints a label again with a reason: a new job copying the ZPL and naming the original; a reason too
 *              short refused in words; who (the office reads the device, never a worker behind a closed gate), when, why
 *   pack       the floor's one PDF holds the labels and the DDT (the packing list waits for the office), page for page; the
 *              office's prints the packing list first and goes to the document printer as ONE print job; the same papers give
 *              the newest back
 *   proforma   the shipment's (customs) with its own PF number, the same contents given back, another language a version with
 *              the same number; refused without the price grain; a priced pack only for someone who sees prices; a deposit
 *              request's (prepayment) gets the next number, a paid one is refused in words
 *   voided     a voided label is never printed again; the pack says which parcel has no label
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let secrets: SecretsService
let fake: FakeSendcloud
let seedA: ShippingSeed

const ns = 'documents-391'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), siteA1: idOf('site:A1'), operator: idOf('worker:A1:operator') }
const YEAR = businessDate(new Date()).slice(0, 4)
const LABEL_PRINTER = idOf('documents-391:printer:label')
const A4_PRINTER = idOf('documents-391:printer:a4')

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.labels.buy', 'shipping.labels.void']
const PRINTING: Permission[] = ['print.view', 'print.labels', 'print.documents']
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office([...SHIPPING, ...PRINTING, 'files.read']),
  // Sees prices: its pack carries a proforma; it makes them.
  priced: office([...SHIPPING, ...PRINTING, 'files.read', 'shipping.proforma.issue', 'money.price']),
  sales: office(['shipping.view', 'shipping.proforma.issue', 'money.price']),
  noPrice: office(['shipping.view', 'shipping.proforma.issue']),
  quality: office(TRAVEL_DOCUMENT_PERMISSIONS),
  packerA1: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: ['shipping.pack', 'print.view', 'print.labels'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]?.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': `documents-391-${run}-${++keys}` } : {}) },
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

async function addAccount(): Promise<string> {
  const id = newId()
  await command(callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'made-up-webhook-secret' })
    await tools.tx.integrationAccount.create({
      data: { id, provider: 'SENDCLOUD', code: `sc-${id.slice(-12)}`, label: 'Sendcloud (test)', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000, companyId: A.companyA },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('documents391')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: ns })
  seedA = (await seedMoney({ db: database, namespace: ns })).shipping
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'PROFORMA', 'MAIN', $4, 'YEARLY', 'PF-{YYYY}-{N:4}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [A.tenant])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const accountId = await addAccount()
  // A1's made-up label printer (ZPL, 203 dpi) and A4 document printer, named in its shipping settings.
  await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-391', 'Test label printer', 'LABEL_ZPL', 'FAKE', 'test-label:9100', 203, 100, 150)`, [LABEL_PRINTER, A.tenant, A.companyA, A.siteA1])
  await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget") VALUES ($1, $2, $3, $4, 'A4-391', 'Test document printer', 'A4_PDF', 'FAKE', 'test-a4')`, [A4_PRINTER, A.tenant, A.companyA, A.siteA1])
  await admin(`UPDATE "ShippingSettings" SET "integrationAccountId" = $1, "labelPrinterId" = $2, "documentPrinterId" = $3 WHERE id = $4`, [accountId, LABEL_PRINTER, A4_PRINTER, A.siteA1])

  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-documents-391-'))
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  fake = new FakeSendcloud()
  const noNetwork = (async () => {
    throw new Error('a test never reaches the network')
  }) as typeof fetch
  useCarrier(createCarrierRuntime({ gateway, environment: 'test', fake, remote: sendcloudAdapter({ fetch: noNetwork }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  await fileTravelDocuments(app, 'quality', seedA.quality.serialStyleId, seedA.quality.serialRevisionId)
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  useCarrier(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const sh2 = () => seedA.draftShipmentId
const S: Record<string, string> = {}
const outbox = (type: string, subject: string) => admin<{ n: number }>(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = $1 AND subject = $2`, [type, subject])

describe('the setup: a packed shipment with its DDT and two carrier labels (W1)', () => {
  it('packs SH-0002 into two weighed parcels, issues its DDT, buys and prints both labels', async () => {
    const [, second, third] = seedA.quality.serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial]))
    const added = (await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/lines`, { lines: [{ workOrderSizeId: seedA.quality.serialCellId, quantity: 1 }] })).shipment
    S.p1 = seedA.draftParcelId
    S.p2 = (await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/parcels`, {}, 201)).parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await ok('warehouse', 'PUT', `/shipping/packing/${sh2()}/lines/${loose.id}/parcel`, { parcelId: S.p2 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[second!], parcelId: S.p1 })
    await ok('warehouse', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[third!], parcelId: S.p2 })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p1}`, { grossWeightKg: '1.85', lengthCm: '40', widthCm: '30', heightCm: '10' })
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '2.2' })
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment.status).toBe('PACKED')
    await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 201)
    const bought = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/labels`, {}, 201)
    expect(bought.outcomes.map((outcome: Json) => outcome.ok)).toEqual([true, true])
    const printed = await ok('packerA1', 'POST', `/shipping/shipments/${sh2()}/labels/print`, {}, 201)
    expect(printed.jobs).toHaveLength(2)
    S.job1 = printed.jobs.find((job: Json) => job.parcelId === S.p1).jobId
  })
})

describe('reprint a label with a reason (LOG-027)', () => {
  const url = () => `/shipping/shipments/${sh2()}/label-jobs`

  it("lists each parcel's label jobs: the carrier label, printable again, asked by a tablet (the office reads the device)", async () => {
    const listed = await ok('warehouse', 'GET', url())
    const first = listed.parcels.find((parcel: Json) => parcel.parcelId === S.p1)
    // Test mode (B-W2b-390): a TEST label, said so.
    expect(first.jobs).toEqual([expect.objectContaining({ jobId: S.job1, kind: 'CARRIER', test: true, status: 'QUEUED', reprintable: true, refusal: null, reprintOfId: null, reason: null, printer: expect.objectContaining({ code: 'LBL-391' }) })])
    expect(first.jobs[0].scanId).toMatch(/^TEST-/)
    expect(first.jobs[0].requestedBy).toMatchObject({ by: 'FLOOR', name: null })
    // A floor reader learns no name.
    expect((await ok('packerA1', 'GET', url())).parcels[0].jobs[0].requestedBy).toEqual({ by: 'FLOOR', name: null, device: null, hidden: true })
  })

  it('refuses a reason too short and a job of another shipment, in words', async () => {
    const error = await refused('packerA1', 'POST', `${url()}/reprint`, { jobIds: [S.job1], reason: 'no' }, 409)
    expect(error).toMatchObject({ message: 'Say why the label is printed again, in 3 to 200 characters.', issues: [{ path: 'refusal/REASON' }] })
    expect((await refused('packerA1', 'POST', `${url()}/reprint`, { jobIds: [newId()], reason: 'Torn at the dock' }, 404)).message).toBe('Label not found on this shipment.')
  })

  it('prints it again: a new job copying the ZPL, naming the original and why; logged on the shipment; nothing bought', async () => {
    const before = fake.requests.length
    const answer = await ok('packerA1', 'POST', `${url()}/reprint`, { jobIds: [S.job1], reason: '  Torn at the dock ' }, 201)
    expect(answer).toMatchObject({ reason: 'Torn at the dock', jobs: [{ reprintOfId: S.job1, parcelId: S.p1, seq: 1, kind: 'CARRIER', test: true, printerId: LABEL_PRINTER, status: 'QUEUED' }] })
    S.reprint = answer.jobs[0].jobId
    const [copy] = await admin(`SELECT r.zpl = o.zpl AS same, r.zpl LIKE '%TEST LABEL%' AS "saysTest", r."reprintOfId", r."reprintReason", r."scanId" = o."scanId" AS "sameCode", r."deviceId" IS NOT NULL AS "byDevice" FROM "PrintJob" r JOIN "PrintJob" o ON o.id = r."reprintOfId" WHERE r.id = $1`, [S.reprint])
    // The TEST label printed again says TEST LABEL as the original does.
    expect(copy).toEqual({ same: true, saysTest: true, reprintOfId: S.job1, reprintReason: 'Torn at the dock', sameCode: true, byDevice: true })
    const [logged] = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Shipment' AND "recordId" = $1 AND action = 'shipping.reprintLabels'`, [sh2()])
    expect(logged!.after).toMatchObject({ reason: 'Torn at the dock', jobs: [{ jobId: S.reprint, reprintOfId: S.job1, parcelSeq: 1, kind: 'CARRIER' }] })
    expect((await outbox('shipping.label_reprinted', sh2()))[0]!.n).toBe(1)
    expect(fake.requests.length).toBe(before)
    const listed = await ok('warehouse', 'GET', url())
    expect(listed.parcels[0].jobs.map((job: Json) => [job.reprintOfId, job.reason])).toEqual([
      [null, null],
      [S.job1, 'Torn at the dock'],
    ])
  })
})

describe('one PDF per shipment (LOG-031)', () => {
  const url = () => `/shipping/shipments/${sh2()}/pack`

  it("says what the floor's pack holds: the labels and the DDT; the packing list waits for the office; no priced paper", async () => {
    const state = await ok('packerA1', 'GET', url())
    expect(state.parts.map((part: Json) => [part.kind, part.state, part.files, part.test])).toEqual([
      ['LABELS', 'READY', 2, true],
      ['PACKING_LIST', 'MISSING', 0, false],
      ['DDT', 'READY', 1, false],
      ['COMMERCIAL_INVOICE', 'NONE', 0, false],
      ['PROFORMA', 'NONE', 0, false],
    ])
    // Test mode: the pack says it holds TEST labels.
    expect(state.test).toBe(true)
    expect(state.parts[0].words).toMatch(/^TEST labels of test mode: marked TEST LABEL - NOT FOR SHIPPING/)
    expect(state.latest).toBeNull()
    expect(state.printer).toBeNull()
  })

  it('makes it at the station: one PDF of every page, kept as version 1; the same papers give it back', async () => {
    const made = await ok('packerA1', 'POST', url(), {})
    expect(made).toMatchObject({ pack: { version: 1, made: true }, test: true, job: null, problem: null })
    expect(made.pack.pages).toBeGreaterThanOrEqual(3)
    const pdf = await call('packerA1', 'GET', `${url()}/pdf`)
    expect(pdf.statusCode, pdf.body).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdfPages(pdf.rawPayload)).toBe(made.pack.pages)
    // Its label pages are the TEST labels' own (TEST LABEL - NOT FOR SHIPPING), its title says TEST.
    expect(pdfText(pdf.rawPayload)).toContain('TEST LABEL - NOT FOR SHIPPING')
    expect(pdf.rawPayload.toString('latin1')).toContain('/Title (SEED-SH-0002 documents - TEST labels, not for shipping)')
    expect((await ok('packerA1', 'POST', url(), {})).pack).toMatchObject({ version: 1, made: false })
    const [row] = await admin(`SELECT g.kind::text, g.version, g.number, f.visibility::text[] AS visibility, f."floorSiteId" FROM "GeneratedDocument" g JOIN "StoredFile" f ON f.id = g."fileId" WHERE g."recordId" = $1 AND g.kind = 'SHIPMENT_PACK'`, [sh2()])
    expect(row).toMatchObject({ kind: 'SHIPMENT_PACK', version: 1, number: 'SEED-SH-0002', visibility: expect.arrayContaining(['FLOOR']), floorSiteId: A.siteA1 })
    expect((await outbox('shipping.pack_made', sh2()))[0]!.n).toBe(1)
  })

  it("the office's pack prints the packing list first and goes to the document printer as ONE print job", async () => {
    const made = await ok('warehouse', 'POST', url(), {})
    expect(made).toMatchObject({ pack: { version: 2, made: true }, job: { printerId: A4_PRINTER, status: 'QUEUED' }, problem: null })
    expect(made.parts.find((part: Json) => part.kind === 'PACKING_LIST')).toMatchObject({ state: 'READY', number: 'SEED-SH-0002' })
    const [job] = await admin(`SELECT j."payloadKind"::text AS payload, j."recordType", j."fileId" = g."fileId" AS "packFile" FROM "PrintJob" j JOIN "GeneratedDocument" g ON g.id = $2 WHERE j.id = $1`, [made.job.jobId, made.pack.documentId])
    expect(job).toEqual({ payload: 'PDF', recordType: 'Shipment', packFile: true })
    expect((await ok('warehouse', 'GET', url())).latest).toMatchObject({ version: 2, current: true })
  })
})

describe('the proforma invoice (LOG-058)', () => {
  it('needs the price grain', async () => {
    expect((await refused('noPrice', 'GET', `/shipping/proformas?recordType=Shipment&recordId=${sh2()}`, undefined, 403)).message).toBe('A proforma shows prices: it needs the price grain.')
    expect((await refused('warehouse', 'POST', '/shipping/proformas', { recordType: 'Shipment', recordId: sh2() }, 403)).code).toBe('forbidden')
  })

  it("makes the shipment's proforma (customs) with its own number; the same contents give it back; English is a version with the same number", async () => {
    expect(await ok('sales', 'GET', `/shipping/proformas?recordType=Shipment&recordId=${sh2()}`)).toMatchObject({ purpose: 'CUSTOMS', number: null, versions: [], problems: [], label: 'SEED-SH-0002' })
    const made = (await ok('sales', 'POST', '/shipping/proformas', { recordType: 'Shipment', recordId: sh2() }, 201)).proforma
    expect(made).toMatchObject({ version: 1, made: true, current: true, number: `PF-${YEAR}-0001` })
    expect((await ok('sales', 'POST', '/shipping/proformas', { recordType: 'Shipment', recordId: sh2() })).proforma).toMatchObject({ version: 1, made: false })
    const english = (await ok('sales', 'POST', '/shipping/proformas', { recordType: 'Shipment', recordId: sh2(), language: 'en' }, 201)).proforma
    expect(english).toMatchObject({ version: 2, number: `PF-${YEAR}-0001`, language: 'en' })
    const [file] = await admin(`SELECT f.visibility::text[] AS visibility, f."partyId" IS NOT NULL AS "forTheCustomer", a.formatted FROM "StoredFile" f, "NumberAllocation" a WHERE f.id = $1 AND a.kind = 'PROFORMA' AND a."recordId" = $2`, [english.fileId, sh2()])
    expect(file).toEqual({ visibility: expect.arrayContaining(['OFFICE', 'PARTNER']), forTheCustomer: true, formatted: `PF-${YEAR}-0001` })
    expect((await ok('sales', 'GET', `/shipping/proformas?recordType=Shipment&recordId=${sh2()}`)).versions.map((entry: Json) => [entry.version, entry.current])).toEqual([
      [2, true],
      [1, false],
    ])
  })

  it('puts the proforma in the pack of someone who sees prices; the floor still reads its own pack', async () => {
    const priced = await ok('priced', 'POST', `/shipping/shipments/${sh2()}/pack`, { print: false })
    expect(priced).toMatchObject({ pack: { version: 3, made: true }, job: null })
    expect(priced.parts.find((part: Json) => part.kind === 'PROFORMA')).toMatchObject({ state: 'READY', number: `PF-${YEAR}-0001` })
    expect((await ok('warehouse', 'GET', `/shipping/shipments/${sh2()}/pack`)).parts.find((part: Json) => part.kind === 'PROFORMA')).toMatchObject({ state: 'NOT_SHOWN' })
    expect((await call('packerA1', 'GET', `/shipping/shipments/${sh2()}/pack/pdf`)).statusCode).toBe(200)
    expect((await refused('packerA1', 'GET', `/shipping/shipments/${sh2()}/pack/pdf?version=3`, undefined, 403)).message).toBe('This pack shows prices.')
  })

  it("makes a deposit request's proforma (prepayment) with the next number; a paid one is refused in words", async () => {
    const paid = (await admin<{ id: string; orderId: string; partyId: string }>(`SELECT id, "orderId", "partyId" FROM "DepositRequest" WHERE "tenantId" = $1 AND status = 'PAID' LIMIT 1`, [A.tenant]))[0]!
    expect((await refused('sales', 'POST', '/shipping/proformas', { recordType: 'DepositRequest', recordId: paid.id }, 409)).message).toBe('This deposit is paid: its invoice is the document now.')
    // A made-up open request on the same order (past the guards: the deposit flow is not this test's).
    const open = newId()
    await admin('SET session_replication_role = replica')
    try {
      await admin(
        `INSERT INTO "DepositRequest" (id, "tenantId", "companyId", "partyId", "orderId", kind, currency, amount, "dueDate", "fiscalDocument", "fiscalRule", status) VALUES ($1, $2, $3, $4, $5, 'ACCONTO', 'EUR', 122000, current_date + 10, 'TD02', 'TEST', 'OPEN')`,
        [open, A.tenant, A.companyA, paid.partyId, paid.orderId],
      )
    } finally {
      await admin('SET session_replication_role = DEFAULT')
    }
    const made = (await ok('sales', 'POST', '/shipping/proformas', { recordType: 'DepositRequest', recordId: open }, 201)).proforma
    expect(made).toMatchObject({ version: 1, number: `PF-${YEAR}-0002` })
    const [row] = await admin(`SELECT g."siteId", g.layout, a.after->>'purpose' AS purpose FROM "GeneratedDocument" g JOIN "AuditLog" a ON a."recordId" = g."recordId" AND a.action = 'shipping.proformaMade' WHERE g.id = $1`, [made.documentId])
    expect(row).toEqual({ siteId: null, layout: 'PROFORMA/1', purpose: 'PREPAYMENT' })
    expect((await outbox('shipping.proforma_made', open))[0]!.n).toBe(1)
  })
})

describe('a voided label (LOG-027)', () => {
  it('is never printed again, and the pack says which parcel has no label', async () => {
    await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p1}/label/void`, { reason: 'Wrong service' })
    const error = await refused('packerA1', 'POST', `/shipping/shipments/${sh2()}/label-jobs/reprint`, { jobIds: [S.reprint], reason: 'Torn again' }, 409)
    expect(error.issues).toEqual([{ path: 'refusal/LABEL_VOIDED', message: expect.stringContaining('Parcel 1: this carrier label was voided or replaced') }])
    const labels = (await ok('packerA1', 'GET', `/shipping/shipments/${sh2()}/pack`)).parts.find((part: Json) => part.kind === 'LABELS')
    // Parcel 2 keeps its TEST label (test mode): said first.
    expect(labels).toMatchObject({ state: 'READY', files: 1, test: true, words: 'TEST labels of test mode: marked TEST LABEL - NOT FOR SHIPPING; nothing was sent to a carrier. Parcel 1 has no carrier label yet.' })
  })
})
