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
import { StepUpRequiredError } from '../../../platform/auth/office/account'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService, type SecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../documents/testing/compliance'
import { createCarrierRuntime, useCarrier } from '../labels/carrier'
import { switchTestMode } from './test-mode'

/**
 * Carriers in depth (B-W2b-390; LOG-035, LOG-045, LOG-122; Rule 1: setting up and training cost nothing in test mode, a label
 * refused at the printer stops the dock) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from
 * the migrations (the runtime login: row-level security, the grants, W1's shipping triggers and B-W2b-367's …_carriers_w2b_guards
 * are real), the factory-db seeds of one tenant up to money (SH-0002, the serial-tracked jacket of SO-0003; SO-0002's released
 * BLK 52), sessions from the test authenticator, the gateway (Redis limits, the call ledger), the local file store and the FAKE
 * Sendcloud. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/test-mode`.
 *
 *   test mode   site A1 starts in test mode: the TEST carrier labels SH-0002 (marked TEST, nothing sent, no Sendcloud call, no
 *               connection needed), prints TEST on the bench, voids without a carrier; going live is refused in words without
 *               a connection, then asks a fresh step-up, then clears the open shipments' TEST labels; live labels go through
 *               the FAKE Sendcloud; back to test mode keeps them
 *   check       every parcel against its carrier's rules before a label (DPD: too heavy; a Swiss address: postal code, phone);
 *               the bench reads it; a buy is refused 409 in words and buys nothing
 *   own van     SB: the DDT cancelled, our own van, a DDT without a carrier, shipped, delivered by a typed status
 *   manual      SM: a carrier booked by hand, its tracking number typed (no label bought for it), on the DDT, corrected after it
 *               left; delivered at a typed time; SH-0002 (carrier labels) never moves by hand
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

const ns = 'carriers-depth-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), operator: idOf('worker:A1:operator') }
const YEAR = businessDate(new Date()).slice(0, 4)
const PRINTER = idOf('carriers-depth:printer:A1')

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.labels.buy', 'shipping.labels.void', 'shipping.settings.view', 'shipping.settings.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId = newId()) => ({ audience: 'office' as const, tenantId: A.tenant, actorId, grants })
const DESK = office([grant([...SHIPPING, 'files.read', 'print.view', 'print.labels'])])
const SESSIONS: Record<string, SessionContext> = {
  desk: DESK,
  viewer: office([grant(['shipping.view', 'shipping.pack', 'shipping.settings.view'])]),
  companyB: office([grant(SHIPPING, [A.companyB])]),
  quality: office([grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
  packerA1: { audience: 'floor', tenantId: A.tenant, actorId: A.operator, siteId: A.siteA1, deviceId: newId(), grants: [{ permissions: ['shipping.pack', 'print.view', 'print.labels'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `carriers-depth-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const refusedFor = async (session: string, method: Method, url: string, payload: unknown, code: string) => {
  const error = await refused(session, method, url, payload, 409)
  expect(error.issues?.[0]?.path, error.message).toBe(`refusal/${code}`)
  return error
}
const calls = (operation: string) => admin<{ n: number }>('SELECT count(*)::int AS n FROM "IntegrationCall" WHERE operation = $1', [operation])
const desk = () => callerFor(database, { ...DESK, requestId: newId() })

async function addAccount(): Promise<string> {
  const id = newId()
  await command(callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'made-up-carriers-depth-webhook-secret' })
    await tools.tx.integrationAccount.create({
      data: { id, companyId: A.companyA, provider: 'SENDCLOUD', code: `sc-${id.slice(-12)}`, label: 'Sendcloud (made-up test)', mode: 'FAKE', webhookSecretId: webhook.id, rateLimitPerMinute: 6000, rateLimitBurst: 1000 },
      select: { id: true },
    })
    tools.audit({ recordType: 'IntegrationAccount', recordId: id })
    return { id }
  })
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('carriers_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: ns })
  seedA = (await seedMoney({ db: database, namespace: ns })).shipping
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'SHIPMENT', 'MAIN', 'ALL', 'NEVER', 'SH-{N:5}', false) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'DDT', 'MAIN', $4, 'YEARLY', '{N}/{YYYY}', true) ON CONFLICT DO NOTHING`, [newId(), A.tenant, A.companyA, YEAR])
  await admin(`UPDATE "NumberSeries" SET "lastIssuedDate" = NULL WHERE "tenantId" = $1 AND kind = 'DDT'`, [A.tenant])
  if ((await admin(`SELECT 1 FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])).length === 0) {
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), A.tenant])
  }
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [A.tenant])
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-T', 'Test label printer', 'LABEL_ZPL', 'FAKE', 'test-label:9100', 203, 100, 150)`,
    [PRINTER, A.tenant, A.companyA, A.siteA1],
  )
  await admin(`UPDATE "ShippingSettings" SET "labelPrinterId" = $1 WHERE id = $2`, [PRINTER, A.siteA1])
  // A made-up release: SO-0002's BLK 54 too (the seed releases its BLK 52 only), for the manual carrier's shipment (past the
  // release guard, as made-up facts the seeds do not have).
  const passed = (await admin<{ inspectionId: string; workOrderId: string }>(`SELECT "inspectionId", "workOrderId" FROM "QualityRelease" WHERE "workOrderSizeId" = $1 LIMIT 1`, [seedA.quality.production.cellIds['BLK-52']]))[0]!
  await admin('SET session_replication_role = replica')
  await admin(
    `INSERT INTO "QualityRelease" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", number, "inspectionId", quantity, "releasedAt", "signatureSha256") VALUES ($1, $2, $3, $4, $5, $6, 'TEST-REL-390', $7, 1, now() - interval '1 hour', $8)`,
    [newId(), A.tenant, A.companyA, A.siteA1, passed.workOrderId, seedA.quality.production.cellIds['BLK-54'], passed.inspectionId, 'a'.repeat(64)],
  )
  await admin('SET session_replication_role = DEFAULT')

  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-carriers-depth-test-'))
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  fake = new FakeSendcloud()
  const noNetwork = (async () => {
    throw new Error('a test never reaches the network')
  }) as typeof fetch
  useCarrier(createCarrierRuntime({ gateway, environment: 'test', fake, remote: sendcloudAdapter({ fetch: noNetwork }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
  await fileTravelDocuments(app, 'quality', seedA.quality.serialStyleId, seedA.quality.serialRevisionId)
  await fileTravelDocuments(app, 'quality', seedA.quality.production.styleId, seedA.quality.production.revisionId)
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
const labelsUrl = (shipmentId: string) => `/shipping/shipments/${shipmentId}/labels`
const modeOf = async (session = 'desk') => ((await ok(session, 'GET', `/shipping/test-mode?siteId=${A.siteA1}`)).sites as Json[])[0]!

describe('test carrier mode (LOG-035): training costs nothing', () => {
  it('starts every site in test mode; the shell reads it; going live is refused in words without a Sendcloud connection', async () => {
    const all = await ok('desk', 'GET', '/shipping/test-mode')
    expect(all.anyInTestMode).toBe(true)
    const site = await modeOf()
    expect(site).toMatchObject({ siteId: A.siteA1, hasSettings: true, testMode: true, liveSince: null, liveSetById: null, words: expect.stringMatching(/^Test mode: a test carrier makes the labels, marked TEST/) })
    expect(site.goLive).toMatchObject({ ready: false, refusal: { code: 'NO_CARRIER_ACCOUNT' }, warning: 'Labels will be bought and charged from now on.', testLabelsToClear: 0 })
    const error = await refusedFor('desk', 'PUT', `/shipping/sites/${A.siteA1}/test-mode`, { testMode: false }, 'NO_CARRIER_ACCOUNT')
    expect(error.message).toMatch(/^Live labels need the company's own Sendcloud connection: This company has no Sendcloud connection/)
    expect((await refused('viewer', 'PUT', `/shipping/sites/${A.siteA1}/test-mode`, { testMode: false }, 403)).code).toBe('forbidden')
    // Another company's desk reads none of company A's sites.
    expect((await ok('companyB', 'GET', `/shipping/test-mode?siteId=${A.siteA1}`)).sites).toEqual([])
  })

  it('labels SH-0002 with the TEST carrier: marked TEST, nothing sent, no Sendcloud call, no connection needed', async () => {
    const [, second, third] = seedA.quality.serialIds
    const codes = Object.fromEntries((await admin<{ id: string; serial: string }>('SELECT id, serial FROM "GarmentSerial" WHERE id = ANY($1::uuid[])', [[second, third]])).map((row) => [row.id, row.serial]))
    const added = (await ok('desk', 'POST', `/shipping/shipments/${sh2()}/lines`, { lines: [{ workOrderSizeId: seedA.quality.serialCellId, quantity: 1 }] })).shipment
    S.p1 = seedA.draftParcelId
    S.p2 = (await ok('desk', 'POST', `/shipping/packing/${sh2()}/parcels`, {}, 201)).parcelId
    const loose = added.lines.find((line: Json) => line.parcelId === null)
    await ok('desk', 'PUT', `/shipping/packing/${sh2()}/lines/${loose.id}/parcel`, { parcelId: S.p2 })
    await ok('desk', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[second!], parcelId: S.p1 })
    await ok('desk', 'POST', `/shipping/packing/${sh2()}/serials`, { serial: codes[third!], parcelId: S.p2 })
    await ok('desk', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p1}`, { grossWeightKg: '1.85', lengthCm: '40', widthCm: '30', heightCm: '10' })
    await ok('desk', 'PATCH', `/shipping/packing/${sh2()}/parcels/${S.p2}`, { grossWeightKg: '2.4' })
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment.status).toBe('PACKED')
    await ok('desk', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 201)

    const bought = await ok('desk', 'POST', labelsUrl(sh2()), {}, 201)
    expect(bought).toMatchObject({ testMode: true, problem: null, toLabel: 0 })
    expect(bought.parcels.map((parcel: Json) => [parcel.seq, parcel.test, parcel.trackingNumber, parcel.trackingUrl, parcel.files.map((file: Json) => file.format)])).toEqual([
      [1, true, expect.stringMatching(/^TEST-[0-9A-F]{10}-\d+$/), null, ['PDF', 'ZPL']],
      [2, true, expect.stringMatching(/^TEST-[0-9A-F]{10}-\d+$/), null, ['PDF', 'ZPL']],
    ])
    S.test1 = bought.parcels[0].trackingNumber
    expect(fake.requests).toHaveLength(0)
    expect(await calls('carrier.create_label')).toEqual([{ n: 0 }])
    expect(await admin(`SELECT "integrationAccountId" FROM "Shipment" WHERE id = $1`, [sh2()])).toEqual([{ integrationAccountId: null }])
    expect((await admin<{ carrierParcelId: string }>(`SELECT "carrierParcelId" FROM "Parcel" WHERE "shipmentId" = $1 ORDER BY seq`, [sh2()])).every((row) => row.carrierParcelId.startsWith('test:'))).toBe(true)
    // The bench reads TEST MODE and prints the TEST label: no barcode, TEST in words.
    expect(await ok('packerA1', 'GET', labelsUrl(sh2()))).toMatchObject({ testMode: true, parcels: [{ test: true }, { test: true }] })
    const printed = await ok('packerA1', 'POST', `${labelsUrl(sh2())}/print`, { parcelIds: [S.p1] }, 201)
    const job = (await admin<{ zpl: string; scanId: string }>(`SELECT zpl, "scanId" FROM "PrintJob" WHERE id = $1`, [printed.jobs[0].jobId]))[0]!
    expect(job.scanId).toBe(S.test1)
    expect(job.zpl).toContain('^FDTEST^FS')
    expect(job.zpl).toContain('TEST LABEL - NOT FOR SHIPPING')
    expect(job.zpl).not.toMatch(/\^BC/)
    expect(await admin(`SELECT after->>'test' AS test FROM "AuditLog" WHERE action = 'shipping.buyLabel' AND "recordId" = $1`, [S.p1])).toEqual([{ test: 'true' }])
  })

  it('voids a TEST label without any carrier, and labels it again with a new TEST number', async () => {
    const voided = await ok('desk', 'POST', `/shipping/shipments/${sh2()}/parcels/${S.p1}/label/void`, { reason: 'Training: wrong parcel' })
    expect(voided.voided).toMatchObject({ seq: 1, carrier: 'NOT_SENT', words: 'The label was never sent to the carrier: cleared here.' })
    expect(await calls('carrier.void_label')).toEqual([{ n: 0 }])
    const again = await ok('desk', 'POST', labelsUrl(sh2()), {}, 201)
    expect(again.parcels[0]).toMatchObject({ test: true, trackingNumber: expect.stringMatching(/^TEST-/) })
    expect(again.parcels[0].trackingNumber).not.toBe(S.test1)
    expect(fake.requests).toHaveLength(0)
  })

  it('switches to live labels only after a fresh step-up; the open shipments’ TEST labels are cleared in the same command', async () => {
    S.account = await addAccount()
    expect((await modeOf()).goLive).toMatchObject({ ready: true, refusal: null, testLabelsToClear: 2 })
    // No fresh code: refused, nothing changed.
    await expect(switchTestMode(desk(), A.siteA1, { testMode: false }, () => {
      throw new StepUpRequiredError()
    }, 'test')).rejects.toBeInstanceOf(StepUpRequiredError)
    expect(await admin(`SELECT "testMode" FROM "ShippingSettings" WHERE id = $1`, [A.siteA1])).toEqual([{ testMode: true }])
    // A stale version is a conflict.
    const version = (await modeOf()).version as number
    await expect(switchTestMode(desk(), A.siteA1, { testMode: false, version: version + 1 }, () => {}, 'test')).rejects.toMatchObject({ code: 'conflict' })

    const live = await switchTestMode(desk(), A.siteA1, { testMode: false, version }, () => {}, 'test')
    expect(live.clearedTestLabels).toBe(2)
    expect(live.site).toMatchObject({ testMode: false, liveSince: expect.any(String), liveSetById: DESK.actorId, words: expect.stringMatching(/^Live labels/), goLive: { ready: false, refusal: { code: 'ALREADY_LIVE' } } })
    expect(await admin(`SELECT count(*)::int AS n FROM "Parcel" WHERE "shipmentId" = $1 AND "trackingNumber" IS NULL AND "carrierParcelId" IS NULL`, [sh2()])).toEqual([{ n: 2 }])
    const view = await ok('desk', 'GET', labelsUrl(sh2()))
    expect(view).toMatchObject({ testMode: false, toLabel: 2 })
    expect((view.voided as Json[]).filter((entry) => entry.carrier === 'NOT_SENT' && /Switched to live labels/.test(entry.reason)).map((entry) => entry.seq).sort()).toEqual([1, 2])
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.test_mode_changed'`)).toEqual([{ payload: { siteId: A.siteA1, testMode: false, clearedTestLabels: 2 } }])
    expect(await admin(`SELECT before->>'testMode' AS before, after->>'testMode' AS after FROM "AuditLog" WHERE "recordType" = 'ShippingSettings' AND "recordId" = $1 AND action = 'shipping.goLive'`, [A.siteA1])).toEqual([{ before: 'true', after: 'false' }])
    // Live already: refused in words before any code is asked (the real route).
    await refusedFor('desk', 'PUT', `/shipping/sites/${A.siteA1}/test-mode`, { testMode: false }, 'ALREADY_LIVE')
  })

  it('buys live labels through the company’s Sendcloud connection (FAKE) from then on', async () => {
    const bought = await ok('desk', 'POST', labelsUrl(sh2()), {}, 201)
    expect(bought.parcels.map((parcel: Json) => [parcel.test, parcel.trackingNumber.startsWith('FK')])).toEqual([
      [false, true],
      [false, true],
    ])
    expect(fake.requests).toHaveLength(2)
    expect(await calls('carrier.create_label')).toEqual([{ n: 2 }])
    expect(await admin(`SELECT "integrationAccountId" FROM "Shipment" WHERE id = $1`, [sh2()])).toEqual([{ integrationAccountId: S.account }])
  })

  it('goes back to test mode without a code (nothing is spent); the live labels stay', async () => {
    const back = await ok('desk', 'PUT', `/shipping/sites/${A.siteA1}/test-mode`, { testMode: true })
    expect(back).toMatchObject({ clearedTestLabels: 0, site: { testMode: true, liveSince: null, liveSetById: null } })
    expect((await ok('desk', 'GET', labelsUrl(sh2()))).parcels.map((parcel: Json) => parcel.test)).toEqual([false, false])
    await refusedFor('desk', 'PUT', `/shipping/sites/${A.siteA1}/test-mode`, { testMode: true }, 'ALREADY_TEST')
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.test_mode_changed' ORDER BY "occurredAt"`)).map((row) => row.payload.testMode)).toEqual([false, true])
  })
})

describe('check every parcel before printing (LOG-045): a label refused at the printer stops the dock', () => {
  it('reads every problem with its carrier in words, on the bench too; a buy is refused 409 in words and buys nothing', async () => {
    const sb = (await ok('desk', 'POST', '/shipping/shipments', { salesOrderId: seedA.quality.production.salesOrderId, carrierCode: 'dpd', serviceCode: 'made-up-dpd-classic', lines: [{ workOrderSizeId: seedA.quality.production.cellIds['BLK-52'], quantity: 1 }] }, 201)).shipment
    S.sb = sb.id
    S.sbParcel = (await ok('desk', 'POST', `/shipping/packing/${sb.id}/parcels`, { grossWeightKg: '34' }, 201)).parcelId
    await ok('desk', 'PUT', `/shipping/packing/${sb.id}/lines/${sb.lines[0].id}/parcel`, { parcelId: S.sbParcel })
    expect((await ok('desk', 'POST', `/shipping/packing/${sb.id}/pack`, {})).shipment.status).toBe('PACKED')

    const check = await ok('packerA1', 'GET', `${labelsUrl(sb.id)}/check`)
    expect(check).toMatchObject({ applies: true, testMode: true, printable: false, carrier: { code: 'dpd', name: 'DPD', ruleKept: true, verified: false, limits: { maxWeightKg: '31.5' } } })
    expect(check.problems.map((problem: Json) => [problem.code, problem.parcelSeq, problem.words])).toEqual([['TOO_HEAVY', 1, 'Parcel 1 weighs 34 kg; DPD takes at most 31.5 kg a parcel: repack it into lighter parcels.']])
    await ok('desk', 'POST', `/shipping/shipments/${sb.id}/ddt`, {}, 201)
    // In test mode too: the TEST carrier is never asked for a parcel its carrier would refuse.
    const heavy = await refusedFor('desk', 'POST', labelsUrl(sb.id), {}, 'TOO_HEAVY')
    expect(heavy.message).toBe('Parcel 1 weighs 34 kg; DPD takes at most 31.5 kg a parcel: repack it into lighter parcels.')
    // A made-up Swiss delivery address without a phone, its postal code of the wrong form (put back after).
    const shipTo = (await admin<{ shipTo: Json }>(`SELECT "shipTo" FROM "Shipment" WHERE id = $1`, [sb.id]))[0]!.shipTo
    await admin(`UPDATE "Shipment" SET "shipTo" = "shipTo" || '{"country": "CH", "postalCode": "80010"}'::jsonb WHERE id = $1`, [sb.id])
    const swiss = await ok('desk', 'GET', `${labelsUrl(sb.id)}/check`)
    expect(swiss.problems.map((problem: Json) => problem.code)).toEqual(['POSTAL_CODE', 'PHONE_NEEDED', 'TOO_HEAVY'])
    const error = await refusedFor('desk', 'POST', labelsUrl(sb.id), {}, 'POSTAL_CODE')
    expect(error.issues.map((issue: Json) => issue.path)).toEqual(['refusal/POSTAL_CODE', 'refusal/PHONE_NEEDED', 'refusal/TOO_HEAVY'])
    expect(error.message).toMatch(/^The carrier would refuse these parcels: The delivery postal code "80010" is not a postal code of CH/)
    expect(await admin(`SELECT "trackingNumber" FROM "Parcel" WHERE id = $1`, [S.sbParcel])).toEqual([{ trackingNumber: null }])
    expect(await calls('carrier.create_label')).toEqual([{ n: 2 }])
    await admin(`UPDATE "Shipment" SET "shipTo" = $1::jsonb WHERE id = $2`, [JSON.stringify(shipTo), sb.id])
  })
})

describe('our own van and a manual carrier (LOG-122): the DDT and the status without a carrier label', () => {
  it('our own van: the DDT cancelled first (it named DPD), then the van, a DDT with no carrier, shipped, delivered by a typed status', async () => {
    expect(await ok('desk', 'GET', `/shipping/shipments/${S.sb}/own-transport`)).toMatchObject({ arrangement: 'CARRIER', may: { arrange: { allowed: false, refusal: { code: 'DECLARED' } } } })
    await refusedFor('desk', 'PUT', `/shipping/shipments/${S.sb}/own-transport`, { mode: 'OWN_VAN' }, 'DECLARED')
    const ddt = (await ok('desk', 'GET', `/shipping/shipments/${S.sb}/own-transport`)).ddt
    await ok('desk', 'POST', `/shipping/ddts/${ddt.id}/cancel`, { reason: 'Our own van takes it' })
    expect((await refused('desk', 'PUT', `/shipping/shipments/${S.sb}/own-transport`, { mode: 'OWN_VAN', carrierName: 'X' }, 400)).issues[0].path).toBe('body/carrierName')
    expect((await refused('viewer', 'PUT', `/shipping/shipments/${S.sb}/own-transport`, { mode: 'OWN_VAN' }, 403)).code).toBe('forbidden')
    const van = await ok('desk', 'PUT', `/shipping/shipments/${S.sb}/own-transport`, { mode: 'OWN_VAN' })
    expect(van).toMatchObject({ arrangement: 'OWN_VAN', shipment: { transportBy: 'SENDER', carrierCode: null, carrierName: null, serviceCode: null }, ddt: null })
    // The check says no carrier label applies; the DDT is issued with no carrier (trasporto a cura del mittente).
    expect(await ok('desk', 'GET', `${labelsUrl(S.sb!)}/check`)).toMatchObject({ applies: false, notApplying: 'OWN_VAN', problems: [] })
    const issued = await ok('desk', 'POST', `/shipping/shipments/${S.sb}/ddt`, {}, 201)
    expect(issued.ddt).toMatchObject({ transportBy: 'SENDER', carrier: null })
    await refusedFor('desk', 'POST', `/shipping/shipments/${S.sb}/own-transport/events`, { status: 'DELIVERED' }, 'NOT_LEFT')
    expect((await ok('desk', 'POST', `/shipping/shipments/${S.sb}/ship`, {})).shipment.status).toBe('SHIPPED')

    const transit = await ok('desk', 'POST', `/shipping/shipments/${S.sb}/own-transport/events`, { status: 'IN_TRANSIT', location: 'Made-up ring road' }, 201)
    expect(transit).toMatchObject({ recorded: { moved: null }, shipment: { status: 'SHIPPED' } })
    const delivered = await ok('desk', 'POST', `/shipping/shipments/${S.sb}/own-transport/events`, { status: 'DELIVERED', description: 'Handed over at the workshop' }, 201)
    expect(delivered).toMatchObject({ recorded: { moved: 'DELIVERED' }, shipment: { status: 'DELIVERED', deliveredAt: expect.any(String) }, may: { status: { allowed: false, refusal: { code: 'ARRIVED' } } } })
    expect(delivered.events.map((event: Json) => [event.status, event.typedById])).toEqual([
      ['DELIVERED', DESK.actorId],
      ['IN_TRANSIT', DESK.actorId],
    ])
    expect(await admin(`SELECT source::text AS source, "parcelId" FROM "TrackingEvent" WHERE "shipmentId" = $1 ORDER BY "occurredAt"`, [S.sb])).toEqual([
      { source: 'MANUAL', parcelId: null },
      { source: 'MANUAL', parcelId: null },
    ])
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.status_changed' AND subject = $1 ORDER BY "occurredAt"`, [S.sb])).map((row) => row.payload.to)).toEqual(['PACKED', 'SHIPPED', 'DELIVERED'])
    await refusedFor('desk', 'POST', `/shipping/shipments/${S.sb}/own-transport/events`, { status: 'RETURNED' }, 'ARRIVED')
  })

  it('a manual carrier: its tracking number typed (no label bought for it), on the DDT, corrected after it left, delivered at a typed time', async () => {
    const sm = (await ok('desk', 'POST', '/shipping/shipments', { salesOrderId: seedA.quality.production.salesOrderId, lines: [{ workOrderSizeId: seedA.quality.production.cellIds['BLK-54'], quantity: 1 }] }, 201)).shipment
    S.sm = sm.id
    expect((await refused('desk', 'PUT', `/shipping/shipments/${sm.id}/own-transport`, { mode: 'MANUAL_CARRIER' }, 400)).issues[0].path).toBe('body/carrierName')
    const manual = await ok('desk', 'PUT', `/shipping/shipments/${sm.id}/own-transport`, { mode: 'MANUAL_CARRIER', carrierName: 'Made-up Trasporti S.r.l.', trackingNumber: 'MT-0001' })
    expect(manual).toMatchObject({ arrangement: 'MANUAL_CARRIER', shipment: { transportBy: 'CARRIER', carrierName: 'Made-up Trasporti S.r.l.', carrierCode: null, serviceCode: null, manualTrackingNumber: 'MT-0001' } })
    const parcel = (await ok('desk', 'POST', `/shipping/packing/${sm.id}/parcels`, { grossWeightKg: '3' }, 201)).parcelId
    await ok('desk', 'PUT', `/shipping/packing/${sm.id}/lines/${sm.lines[0].id}/parcel`, { parcelId: parcel })
    await ok('desk', 'POST', `/shipping/packing/${sm.id}/pack`, {})
    expect(await ok('desk', 'GET', `${labelsUrl(sm.id)}/check`)).toMatchObject({ applies: false, notApplying: 'MANUAL_CARRIER' })
    const ddt = await ok('desk', 'POST', `/shipping/shipments/${sm.id}/ddt`, {}, 201)
    expect(ddt.ddt).toMatchObject({ transportBy: 'CARRIER', carrier: { name: 'Made-up Trasporti S.r.l.' } })
    const noLabel = await refused('desk', 'POST', labelsUrl(sm.id), {}, 409)
    expect(noLabel.message).toMatch(/booked by hand \(its tracking number typed\): no label is bought here/)
    expect((await ok('desk', 'POST', `/shipping/shipments/${sm.id}/ship`, {})).shipment.status).toBe('SHIPPED')

    await refusedFor('desk', 'PUT', `/shipping/shipments/${sm.id}/own-transport`, { mode: 'OWN_VAN' }, 'LEFT')
    expect((await ok('desk', 'PUT', `/shipping/shipments/${sm.id}/own-transport/tracking`, { trackingNumber: ' MT-0002 ' })).shipment.manualTrackingNumber).toBe('MT-0002')
    expect((await refused('desk', 'PUT', `/shipping/shipments/${sm.id}/own-transport/tracking`, { trackingNumber: 'a\nb' }, 400)).issues[0].path).toBe('body/trackingNumber')
    // The search finds it by the typed number (B-W2b-386).
    expect(((await ok('desk', 'GET', '/shipping/queue/search?q=MT-0002')).shipments as Json[]).map((row) => row.id)).toContain(sm.id)

    const shippedAt = (await admin<{ shippedAt: Date }>(`SELECT "shippedAt" FROM "Shipment" WHERE id = $1`, [sm.id]))[0]!.shippedAt
    expect((await refused('desk', 'POST', `/shipping/shipments/${sm.id}/own-transport/events`, { status: 'DELIVERED', occurredAt: new Date(shippedAt.getTime() - 60_000).toISOString() }, 400)).issues[0].path).toBe('body/occurredAt')
    expect((await refused('desk', 'POST', `/shipping/shipments/${sm.id}/own-transport/events`, { status: 'DELIVERED', occurredAt: new Date(Date.now() + 3_600_000).toISOString() }, 400)).message).toBe('The time is in the future.')
    const at = new Date(Math.max(shippedAt.getTime() + 1_000, Date.now() - 1_000)).toISOString()
    const delivered = await ok('desk', 'POST', `/shipping/shipments/${sm.id}/own-transport/events`, { status: 'DELIVERED', occurredAt: at }, 201)
    expect(delivered.shipment).toMatchObject({ status: 'DELIVERED', deliveredAt: at })
  })

  it("never moves a shipment its carrier tracks by hand, never types a number beside a carrier's label", async () => {
    expect((await ok('desk', 'POST', `/shipping/shipments/${sh2()}/ship`, {})).shipment.status).toBe('SHIPPED')
    await refusedFor('desk', 'POST', `/shipping/shipments/${sh2()}/own-transport/events`, { status: 'DELIVERED' }, 'CARRIER_TRACKED')
    await refusedFor('desk', 'PUT', `/shipping/shipments/${sh2()}/own-transport/tracking`, { trackingNumber: 'MT-9' }, 'LABELLED')
    expect((await refused('companyB', 'GET', `/shipping/shipments/${sh2()}/own-transport`, undefined, 404)).code).toBe('not_found')
  })
})
