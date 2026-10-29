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
import { FakeSendcloud, type FakeWebhook } from '../../../adapters/sendcloud/fake'
import { sendcloudAdapter } from '../../../adapters/sendcloud/sendcloud'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { processReceipt } from '../../../platform/inbound/process'
import { INBOUND_PROVIDERS, useInbound, type InboundRuntime } from '../../../platform/inbound/providers'
import { fakeSignatureHeaders } from '../../../platform/inbound/verifiers'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService, type SecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { createCarrierRuntime, useCarrier, type CarrierRuntime } from './carrier'
import { pollShipment, runTrackingPoll } from './poll'

/**
 * Carrier labels and tracking (B-W1-48; PLAN §4.7 stage 14-ship "2 parcels; DDT; carrier label (fake); tracking
 * delivered") on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations
 * (the runtime login: row-level security, the grants, the …_quality_shipping_guards triggers are real), the factory-db
 * seeds of two tenants (the DRAFT SH-0002 of the serial-tracked jacket), company A's FAKE Sendcloud account named in
 * site A1's shipping settings with its label printer, the gateway (Redis limits, the call ledger), the local file
 * store, the inbound ledger and the FAKE Sendcloud. A LIVE account reaches a Sendcloud adapter whose network fails the
 * test: nothing leaves the machine. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs labels`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let secrets: SecretsService
let carrier: CarrierRuntime
let fake: FakeSendcloud
let seedA: ShippingSeed
let accountId: string
const networkCalls: string[] = []

const WEBHOOK_SECRET = 'made-up-sendcloud-webhook-secret'
const ns = { a: 'labels-a', b: 'labels-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = { tenant: idOf(ns.a, 'tenant'), companyA: idOf(ns.a, 'company:A'), companyB: idOf(ns.a, 'company:B'), siteA1: idOf(ns.a, 'site:A1'), brand: idOf(ns.a, 'party:P1'), operator: idOf(ns.a, 'worker:A1:operator') }
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A') }
const YEAR = businessDate(new Date()).slice(0, 4)
const PRINTER = idOf(ns.a, 'labels-test:printer:A1')

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.labels.buy', 'shipping.labels.void']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant([...SHIPPING, 'files.read', 'print.view', 'print.labels'])]),
  viewer: office(A.tenant, [grant(['shipping.view'])]),
  packerOffice: office(A.tenant, [grant(['shipping.view', 'shipping.pack'])]),
  companyB: office(A.tenant, [grant([...SHIPPING, 'print.labels'], [A.companyB])]),
  otherTenant: office(B.tenant, [grant([...SHIPPING, 'print.labels'])]),
  packerA1: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: ['shipping.pack', 'print.view', 'print.labels'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-test-session': session, ...(SESSIONS[session]?.audience === 'floor' && method !== 'GET' ? { 'idempotency-key': `labels-test-${run}-${++keys}` } : {}) },
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

const deliver = (hook: Pick<FakeWebhook, 'body' | 'headers'>, account = accountId) =>
  app.inject({ method: 'POST', url: `/inbound/sendcloud/${A.tenant}/${account}`, payload: hook.body, headers: hook.headers })
const inbound = (): InboundRuntime => ({ environment: 'test', providers: INBOUND_PROVIDERS, secrets, clock: { now: () => new Date() } })
/** Posts a webhook and processes its receipt as the worker would. */
async function webhook(hook: FakeWebhook): Promise<string> {
  const answer = await deliver(hook)
  expect(answer.statusCode, answer.body).toBe(200)
  const { status, receiptId } = answer.json()
  if (status === 'received') await processReceipt(callerFor(database, systemContext(A.tenant, newId())), receiptId, newId(), inbound())
  return status
}
/** A Sendcloud status change for a tracking number, signed as the FAKE signs (it changes nothing at the fake carrier). */
function statusHook(trackingNumber: string, statusId: number, secret = WEBHOOK_SECRET): FakeWebhook {
  const body = JSON.stringify({ action: 'parcel_status_changed', timestamp: Date.now(), parcel: { id: 999, tracking_number: trackingNumber, status: { id: statusId, message: 'Made up' } } })
  const key = `parcel_status_changed:999:${statusId}:${newId()}`
  return { body, key, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(secret, body, new Date(), { id: key }) } }
}
const tracking = (shipmentId: string) =>
  admin<{ parcelId: string; status: string; source: string }>('SELECT "parcelId", status::text AS status, source::text AS source FROM "TrackingEvent" WHERE "shipmentId" = $1 ORDER BY "occurredAt", "recordedAt"', [shipmentId])
const parcelsOf = (shipmentId: string) =>
  admin<{ id: string; seq: number; trackingNumber: string | null; carrierParcelId: string | null; labelledAt: Date | null; version: number }>(
    'SELECT id, seq, "trackingNumber", "carrierParcelId", "labelledAt", version FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq',
    [shipmentId],
  )
const calls = (operation: string) => admin<{ status: string; n: number }>('SELECT status::text AS status, count(*)::int AS n FROM "IntegrationCall" WHERE operation = $1 GROUP BY status ORDER BY status', [operation])

/** An integration account made as the office does (its webhook secret sealed). */
async function addAccount(tenantId: string, fields: Record<string, unknown>): Promise<string> {
  const id = newId()
  await command(callerFor(database, { audience: 'office', tenantId, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: WEBHOOK_SECRET })
    await tools.tx.integrationAccount.create({
      data: { id, provider: 'SENDCLOUD', code: `sc-${id.slice(-12)}`, label: 'Sendcloud (test)', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000, ...fields },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('labels')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  seedA = (await seedMoney({ db: database, namespace: ns.a })).shipping
  await seedMoney({ db: database, namespace: ns.b })
  for (const [tenantId, companyId] of [
    [A.tenant, A.companyA],
    [B.tenant, B.companyA],
  ] as const) {
    await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId])
    await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), tenantId, companyId, YEAR])
    await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [tenantId])
    if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])).length === 0) {
      await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    }
    // Every label is two files and a DDT one more: the seeded store's default burst (10) is a production setting.
    await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [tenantId])
  }
  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  // Company A's own FAKE Sendcloud account, named in site A1's settings with its label printer (ZPL).
  accountId = await addAccount(A.tenant, { companyId: A.companyA })
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-T', 'Test label printer', 'LABEL_ZPL', 'FAKE', 'test-label:9100', 203, 100, 150)`,
    [PRINTER, A.tenant, A.companyA, A.siteA1],
  )
  await admin(`UPDATE "ShippingSettings" SET "integrationAccountId" = $1, "labelPrinterId" = $2 WHERE id = $3`, [accountId, PRINTER, A.siteA1])

  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-labels-test-'))
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  fake = new FakeSendcloud()
  const noNetwork = (async (url: string | URL) => {
    networkCalls.push(String(url))
    throw new Error('a test never reaches the network')
  }) as typeof fetch
  carrier = createCarrierRuntime({ gateway, environment: 'test', fake, remote: sendcloudAdapter({ fetch: noNetwork }) })
  useCarrier(carrier)
  useInbound(inbound())
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  useCarrier(undefined)
  useInbound(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

// SH-0002 (seeded DRAFT, the serial-tracked jacket of SO-0003): two parcels, a serial each; parcel 2 first weighed too
// heavy for the fake carrier (a partial buy). SB: one released BLK 52 of SO-0002, one parcel (the return).
const sh2 = () => seedA.draftShipmentId
const S: Record<string, string> = {}
const labelsUrl = (shipmentId: string) => `/shipping/shipments/${shipmentId}/labels`

describe('a packed shipment with its DDT (the floor packs; LOG-039)', () => {
  it('packs SH-0002 into two weighed parcels with a serial each (parcel 2 at 31.5 kg), and SB into one', async () => {
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
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '31.5' })
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment.status).toBe('PACKED')

    const sb = (await ok('warehouse', 'POST', '/shipping/shipments', { salesOrderId: seedA.quality.production.salesOrderId, lines: [{ workOrderSizeId: seedA.quality.production.cellIds['BLK-52'], quantity: 1 }] }, 201)).shipment
    S.sb = sb.id
    S.sbParcel = (await ok('warehouse', 'POST', `/shipping/packing/${sb.id}/parcels`, { grossWeightKg: '2.5' }, 201)).parcelId
    await ok('warehouse', 'PUT', `/shipping/packing/${sb.id}/lines/${sb.lines[0].id}/parcel`, { parcelId: S.sbParcel })
    expect((await ok('warehouse', 'POST', `/shipping/packing/${sb.id}/pack`, {})).shipment.status).toBe('PACKED')
  })

  it('buys no label without a live DDT (409), and spends nothing', async () => {
    const error = await refused('warehouse', 'POST', labelsUrl(sh2()), {}, 409)
    expect(error).toMatchObject({ code: 'invalid_state', message: expect.stringContaining('The shipment has no live DDT: issue the DDT first') })
    expect(fake.requests).toHaveLength(0)
    expect(await calls('carrier.create_label')).toEqual([])
  })

  it('issues the DDTs, the goods still PACKED (they leave later)', async () => {
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 201)).shipment.status).toBe('PACKED')
    // SB was planned without a carrier name (the shipment form sets only the code): the DDT names it.
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/ddt`, { carrier: { name: 'Seed Express' } }, 201)).shipment.status).toBe('PACKED')
  })
})

describe('buying labels (LOG-025, LOG-032; the company pays)', () => {
  it('keeps buying to the office: a floor device, a viewer and the walls of company, tenant and audience refuse', async () => {
    expect((await refused('packerA1', 'POST', labelsUrl(sh2()), {}, 403)).code).toBe('forbidden')
    expect((await refused('viewer', 'POST', labelsUrl(sh2()), {}, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'POST', labelsUrl(sh2()), {}, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'POST', labelsUrl(sh2()), {}, 404)).code).toBe('not_found')
    expect((await refused('companyB', 'GET', labelsUrl(sh2()), undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', labelsUrl(sh2()), undefined, 404)).code).toBe('not_found')
    expect(fake.requests).toHaveLength(0)
  })

  it('buys what it can: parcel 1 labelled (PDF and ZPL stored), parcel 2 refused by the carrier and said so (201)', async () => {
    const answer = await ok('warehouse', 'POST', labelsUrl(sh2()), {}, 201)
    expect(answer.outcomes).toEqual([
      { parcelId: S.p1, seq: 1, ok: true },
      { parcelId: S.p2, seq: 2, ok: false, problem: expect.stringContaining('the parcel weighs more than this service takes') },
    ])
    expect(answer.problem).toBe("1 of 2 labels were bought; parcel 2 still need one: see each parcel's problem, then buy again (the labels bought are kept).")
    const [first, second] = answer.parcels
    expect(first).toMatchObject({ seq: 1, trackingNumber: expect.stringMatching(/^FK[0-9A-F]{12}$/), files: [expect.objectContaining({ format: 'PDF' }), expect.objectContaining({ format: 'ZPL' })] })
    expect(second).toMatchObject({ seq: 2, trackingNumber: null, files: [] })
    expect(answer.toLabel).toBe(1)
    const [row] = await parcelsOf(sh2())
    expect(row).toMatchObject({ trackingNumber: first.trackingNumber, carrierParcelId: expect.stringMatching(/^fk-[0-9a-f]{8}:\d+$/), labelledAt: expect.any(Date) })
    const files = await admin('SELECT kind::text AS kind, "contentType", visibility::text[] AS visibility, "floorSiteId", "companyId" FROM "StoredFile" WHERE "recordType" = $1 AND "recordId" = $2 ORDER BY "contentType"', ['Parcel', S.p1])
    expect(files).toEqual([
      { kind: 'DOCUMENT', contentType: 'application/pdf', visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.siteA1, companyId: A.companyA },
      { kind: 'ATTACHMENT', contentType: 'text/plain', visibility: ['OFFICE', 'FLOOR'], floorSiteId: A.siteA1, companyId: A.companyA },
    ])
    expect(fake.requests.map((request) => request.externalReference)).toEqual([`${S.p1}.v${row!.version - 1}`, `${S.p2}.v${(await parcelsOf(sh2()))[1]!.version}`])
    expect(fake.requests[0]).toMatchObject({ shipmentNumber: expect.any(String), parcels: 2, serviceCode: 'seed-standard', weightKg: '1.8500', lengthCm: '40.00', from: expect.objectContaining({ country: 'IT' }) })
    expect(await admin(`SELECT "carrierName", "integrationAccountId" FROM "Shipment" WHERE id = $1`, [sh2()])).toEqual([{ carrierName: 'Seed Express', integrationAccountId: accountId }])
    // One gateway call per carrier operation, in the ledger.
    expect(await calls('carrier.create_label')).toEqual([
      { status: 'FAILED', n: 1 },
      { status: 'SUCCEEDED', n: 1 },
    ])
    expect(await calls('carrier.label_document')).toEqual([{ status: 'SUCCEEDED', n: 2 }])
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.labels_bought' AND subject = $1`, [sh2()])).toEqual([{ n: 1 }])
  })

  it('keeps a labelled parcel as it was bought: no new weight or size (409) until its label is voided', async () => {
    const error = await refused('packerA1', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p1}`, { grossWeightKg: '1.9' }, 409)
    expect(error.message).toBe('Parcel 1 has a carrier label: void the label first (it was bought for this weight, size and contents).')
    expect((await refused('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p1}`, { lengthCm: '41' }, 409)).message).toContain('void the label first')
    expect((await refused('packerA1', 'POST', `/shipping/packing/${sh2()}/unpack`, {}, 409)).message).toContain('no carrier label')
    // Parcel 2 has none yet: it is weighed again.
    await ok('warehouse', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '2.15' })
  })

  it('buys the missing one; a second buy has nothing to buy and calls no carrier (idempotent)', async () => {
    const answer = await ok('warehouse', 'POST', labelsUrl(sh2()), {}, 201)
    expect(answer.outcomes).toEqual([{ parcelId: S.p2, seq: 2, ok: true }])
    expect(answer.problem).toBeNull()
    expect(answer.toLabel).toBe(0)
    S.track1 = answer.parcels[0].trackingNumber
    S.track2 = answer.parcels[1].trackingNumber
    expect(S.track2).toMatch(/^FK/)
    const asked = fake.requests.length
    const again = await ok('warehouse', 'POST', labelsUrl(sh2()), {}, 200)
    expect(again).toMatchObject({ outcomes: [], problem: null, toLabel: 0 })
    expect(again.parcels.map((parcel: Json) => parcel.trackingNumber)).toEqual([S.track1, S.track2])
    expect(fake.requests).toHaveLength(asked)
    expect(await admin(`SELECT count(*)::int AS n FROM "StoredFile" WHERE "recordType" = 'Parcel' AND "recordId" = ANY($1::uuid[])`, [[S.p1, S.p2]])).toEqual([{ n: 4 }])
  })

  it('asks the carrier again with the same reference after a lost answer: the same label, never a second one', async () => {
    const [, parcel] = await parcelsOf(sh2())
    // As if the first answer had been lost: the same reference again is the same label at the carrier.
    const repeat = await carrier.createLabel(callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [], requestId: newId() }), accountId, {
      ...fake.requests.at(-1)!,
    })
    expect(repeat.trackingNumber).toBe(parcel!.trackingNumber)
  })

  it('voids parcel 2 before the goods leave; then it changes and is labelled again with a new label', async () => {
    expect((await refused('packerA1', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p2}/label/void`, { reason: 'Wrong box' }, 403)).code).toBe('forbidden')
    const voided = await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p2}/label/void`, { reason: 'Wrong box size' })
    expect(voided.voided).toEqual({ parcelId: S.p2, seq: 2, carrier: 'CANCELLED' })
    expect(voided.parcels[1]).toMatchObject({ trackingNumber: null, labelledAt: null, files: [] })
    expect(fake.labelOf(S.track2!).voided).toBe('CANCELLED')
    const audit = await admin(`SELECT before, after, reason FROM "AuditLog" WHERE action = 'shipping.voidLabel' AND "recordId" = $1`, [S.p2])
    expect(audit).toEqual([{ before: expect.objectContaining({ trackingNumber: S.track2 }), after: { trackingNumber: null, carrier: 'CANCELLED' }, reason: 'Wrong box size' }])
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p2}/label/void`, { reason: 'Again' }, 409)).message).toBe('Parcel 2 has no carrier label.')

    await ok('packerA1', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '2.2' })
    const before = S.track2
    const rebought = await ok('warehouse', 'POST', labelsUrl(sh2()), {}, 201)
    S.track2 = rebought.parcels[1].trackingNumber
    expect(S.track2).toMatch(/^FK/)
    expect(S.track2).not.toBe(before)
    expect(fake.labelOf(S.track2!).voided).toBeNull()
    expect(rebought.parcels[1].files).toHaveLength(2)
  })

  it('refuses a void the carrier refuses (409, nothing changes)', async () => {
    fake.refuseVoidNext()
    const error = await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p1}/label/void`, { reason: 'Test' }, 409)
    expect(error.message).toBe('The label of parcel 1 stays: Sendcloud refused to cancel the label: the carrier has the parcel already (fake).')
    expect((await parcelsOf(sh2()))[0]!.trackingNumber).toBe(S.track1)
  })
})

describe('printing the labels (GAP-007; the floor prints, never buys)', () => {
  it('queues each label ZPL for the site label printer, from a floor device; the labels view shows the print state', async () => {
    const printed = await ok('packerA1', 'POST', `${labelsUrl(sh2())}/print`, {}, 201)
    expect(printed.jobs).toEqual([
      { jobId: expect.any(String), parcelId: S.p1, seq: 1, status: 'QUEUED' },
      { jobId: expect.any(String), parcelId: S.p2, seq: 2, status: 'QUEUED' },
    ])
    const jobs = await admin<{ zpl: string; scanId: string; deviceId: string | null; printerId: string }>(
      `SELECT zpl, "scanId", "deviceId", "printerId" FROM "PrintJob" WHERE "recordType" = 'Parcel' AND "recordId" = ANY($1::uuid[]) ORDER BY "scanId" = $2 DESC`,
      [[S.p1, S.p2], S.track1],
    )
    expect(jobs.map((job) => job.scanId)).toEqual([S.track1, S.track2])
    expect(jobs[0]!.zpl).toContain(`^FD${S.track1}^FS`)
    const device = SESSIONS.packerA1!.audience === 'floor' ? SESSIONS.packerA1!.deviceId : null
    expect(jobs.map((job) => [job.printerId, job.deviceId])).toEqual([
      [PRINTER, device],
      [PRINTER, device],
    ])
    const view = await ok('packerA1', 'GET', labelsUrl(sh2()))
    expect(view.parcels.map((parcel: Json) => parcel.print?.status)).toEqual(['QUEUED', 'QUEUED'])
    expect(view.cutOff).toMatchObject({ time: '16:00', at: expect.any(String) })
    expect((await refused('viewer', 'POST', `${labelsUrl(sh2())}/print`, {}, 403)).code).toBe('forbidden')
    expect((await refused('companyB', 'POST', `${labelsUrl(sh2())}/print`, {}, 404)).code).toBe('not_found')
  })
})

describe('the account (Owner Q20: the company own Sendcloud account; LIVE only with it)', () => {
  it('refuses SB without a Sendcloud account of its company (409), and sends nothing', async () => {
    await admin(`UPDATE "IntegrationAccount" SET status = 'DISABLED' WHERE id = $1`, [accountId])
    await admin(`UPDATE "ShippingSettings" SET "integrationAccountId" = NULL WHERE id = $1`, [A.siteA1])
    await admin(`UPDATE "Shipment" SET "integrationAccountId" = NULL WHERE id = $1`, [S.sb])
    const error = await refused('warehouse', 'POST', labelsUrl(S.sb!), {}, 409)
    expect(error.message).toBe(
      "This company has no Sendcloud connection: labels are bought only through the company's own Sendcloud account (an administrator adds it under Connections and names it in the site's shipping settings). Local and test use a FAKE account.",
    )
  })

  it("refuses a tenant-wide account (not the company's own)", async () => {
    const tenantWide = await addAccount(A.tenant, { companyId: null, mode: 'LIVE' })
    await admin(`UPDATE "Shipment" SET "integrationAccountId" = $1 WHERE id = $2`, [tenantWide, S.sb])
    expect((await refused('warehouse', 'POST', labelsUrl(S.sb!), {}, 409)).message).toBe("The Sendcloud connection named is not this company's own: labels are bought only with the shipping company's account.")
    await admin(`UPDATE "IntegrationAccount" SET status = 'DISABLED' WHERE id = $1`, [tenantWide])
  })

  it('a LIVE account of the company without its API keys: the gateway call fails before any network, nothing is recorded', async () => {
    const live = await addAccount(A.tenant, { companyId: A.companyA, mode: 'LIVE' })
    await admin(`UPDATE "Shipment" SET "integrationAccountId" = $1 WHERE id = $2`, [live, S.sb])
    const error = await refused('warehouse', 'POST', labelsUrl(S.sb!), {}, 409)
    expect(error.message).toBe('No label was bought (parcel 1): see each parcel\'s problem, then buy again.')
    expect(error.issues).toEqual([{ path: 'parcels/1', message: 'The Sendcloud connection has no API keys: an administrator adds them under Connections.' }])
    expect(await admin(`SELECT status::text AS status, attempts FROM "IntegrationCall" WHERE "accountId" = $1`, [live])).toEqual([{ status: 'FAILED', attempts: 1 }])
    expect(networkCalls).toEqual([])
    expect((await parcelsOf(S.sb!))[0]!.trackingNumber).toBeNull()
    // Back to the company's FAKE account for the rest.
    await admin(`UPDATE "IntegrationAccount" SET status = 'DISABLED' WHERE id = $1`, [live])
    await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE id = $1`, [accountId])
    await admin(`UPDATE "Shipment" SET "integrationAccountId" = $1 WHERE id = $2`, [accountId, S.sb])
    await admin(`UPDATE "ShippingSettings" SET "integrationAccountId" = $1 WHERE id = $2`, [accountId, A.siteA1])
  })
})

describe('tracking (LOG-059): webhooks through the inbound ledger, and the poll', () => {
  it('ships SH-0002; then a void is refused (the goods left)', async () => {
    expect((await ok('warehouse', 'POST', `/shipping/shipments/${sh2()}/ship`, {})).shipment.status).toBe('SHIPPED')
    expect((await refused('warehouse', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p1}/label/void`, { reason: 'Late' }, 409)).message).toBe(
      'The shipment is SHIPPED; a label is voided only before the goods leave.',
    )
  })

  it('records a webhook replayed twice once, also when Sendcloud resends it under another delivery', async () => {
    const [transit, out, delivered] = fake.play(S.track1!, 'delivered', WEBHOOK_SECRET, new Date(Date.now() - 3 * 3_600_000))
    expect(await webhook(transit!)).toBe('received')
    expect(await webhook(transit!)).toBe('duplicate')
    expect(await admin(`SELECT count(*)::int AS n FROM "InboundWebhook" WHERE "accountId" = $1`, [accountId])).toEqual([{ n: 1 }])
    // The same carrier event under another delivery id: a second receipt, still one event.
    const resent = { body: transit!.body, headers: { 'content-type': 'application/json', ...fakeSignatureHeaders(WEBHOOK_SECRET, transit!.body, new Date(), { id: `resend-${newId()}` }) } }
    expect((await deliver(resent)).json().status).toBe('received')
    const receipt = (await admin<{ id: string }>(`SELECT id FROM "InboundWebhook" WHERE "accountId" = $1 AND status = 'RECEIVED'`, [accountId]))[0]!
    expect(await processReceipt(callerFor(database, systemContext(A.tenant, newId())), receipt.id, newId(), inbound())).toBe('processed')
    expect(await tracking(sh2())).toEqual([{ parcelId: S.p1, status: 'IN_TRANSIT', source: 'WEBHOOK' }])

    await webhook(out!)
    await webhook(delivered!)
    const view = await ok('viewer', 'GET', `/shipping/shipments/${sh2()}/tracking`)
    expect(view.parcels.map((parcel: Json) => parcel.status)).toEqual(['DELIVERED', null])
    expect(view.shipment.status).toBe('SHIPPED')
    expect(view.events.map((event: Json) => event.status)).toEqual(['DELIVERED', 'OUT_FOR_DELIVERY', 'IN_TRANSIT'])
  })

  it('ignores a webhook for a voided label, another account, or a bad signature', async () => {
    const voided = fake.labelOf(fake.voids[0]!).label
    expect(await webhook(statusHook(voided.trackingNumber, 3))).toBe('received')
    const other = await addAccount(A.tenant, { companyId: A.companyA })
    const answer = await deliver(statusHook(S.track2!, 3), other)
    expect(await processReceipt(callerFor(database, systemContext(A.tenant, newId())), answer.json().receiptId, newId(), inbound())).toBe('processed')
    expect((await deliver(statusHook(S.track2!, 11, 'not-the-secret'))).statusCode).toBe(401)
    expect((await tracking(sh2())).filter((event) => event.parcelId === S.p2)).toEqual([])
    await admin(`UPDATE "IntegrationAccount" SET status = 'DISABLED' WHERE id = $1`, [other])
  })

  it('the poll finds a lost update: parcel 2 delivered with no webhook, so the shipment is DELIVERED', async () => {
    // The carrier's events after the label (the fake's label event): never posted.
    fake.advance(S.track2!, 'IN_TRANSIT', WEBHOOK_SECRET, new Date(Date.now() + 60_000))
    fake.advance(S.track2!, 'DELIVERED', WEBHOOK_SECRET, new Date(Date.now() + 120_000))
    // Twelve hours of silence later, the hourly tick asks for a poll of SH-0002 (once per tenant and hour).
    const later = { now: () => new Date(Date.now() + 12 * 3_600_000 + 5 * 60_000) }
    const tick = await runTrackingPoll({ database, log: { info() {}, warn() {}, error() {} }, clock: later })
    expect(tick).toMatchObject({ shipments: 1, failed: 0 })
    expect(await runTrackingPoll({ database, log: { info() {}, warn() {}, error() {} }, clock: later })).toMatchObject({ shipments: 1 })
    const due = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.tracking_poll_due'`)
    expect(due).toEqual([{ payload: { shipmentId: sh2(), parcels: 1 } }])
    const polled = await pollShipment(carrier, callerFor(database, systemContext(A.tenant, newId())), sh2())
    expect(polled).toEqual({ recorded: 3, moved: 'DELIVERED', failures: [] })
    expect(await admin(`SELECT status::text AS status, "deliveredAt" IS NOT NULL AS delivered FROM "Shipment" WHERE id = $1`, [sh2()])).toEqual([{ status: 'DELIVERED', delivered: true }])
    expect((await tracking(sh2())).filter((event) => event.parcelId === S.p2)).toEqual([
      { parcelId: S.p2, status: 'LABEL_CREATED', source: 'POLL' },
      { parcelId: S.p2, status: 'IN_TRANSIT', source: 'POLL' },
      { parcelId: S.p2, status: 'DELIVERED', source: 'POLL' },
    ])
  })

  it('takes the late webhook of the delivery the poll found as the same event', async () => {
    const late = fake.advance(S.track2!, 'DELIVERED', WEBHOOK_SECRET, new Date(Date.now() + 180_000))
    expect(await webhook(late)).toBe('received')
    expect((await tracking(sh2())).filter((event) => event.parcelId === S.p2 && event.status === 'DELIVERED')).toHaveLength(1)
  })

  it('moves SB to RETURNED when its parcel comes back', async () => {
    await ok('warehouse', 'POST', labelsUrl(S.sb!), {}, 201)
    await ok('warehouse', 'POST', `/shipping/shipments/${S.sb}/ship`, {})
    const sbTrack = (await parcelsOf(S.sb!))[0]!.trackingNumber!
    for (const hook of fake.play(sbTrack, 'returned', WEBHOOK_SECRET, new Date(Date.now() - 3 * 3_600_000))) await webhook(hook)
    expect(await admin(`SELECT status::text AS status, "returnedAt" IS NOT NULL AS returned FROM "Shipment" WHERE id = $1`, [S.sb])).toEqual([{ status: 'RETURNED', returned: true }])
    expect((await ok('viewer', 'GET', `/shipping/shipments/${S.sb}/tracking`)).parcels).toEqual([expect.objectContaining({ status: 'RETURNED' })])
    expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'shipment.status_changed' AND payload->>'to' = 'RETURNED'`)).toEqual([{ n: 1 }])
  })
})
