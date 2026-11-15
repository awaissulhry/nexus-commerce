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
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
import { weekdayOf } from '@nexus/factory-domain/shipping/queue/cutoff'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedMoney } from '../../../../../../packages/factory-db/seed/money'
import type { ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { FakeSendcloudPickups, sendcloudPickupsAdapter } from '../../../adapters/sendcloud/pickups'
import { buildApp } from '../../../core/app'
import { callerFor, command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../../../platform/files/service'
import { storeGeneratedFile } from '../../../platform/files/files'
import { createGateway } from '../../../platform/gateway/gateway'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService, type SecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { collectionDeliveredHandler } from '../collection/delivered'
import { fileTravelDocuments, madeUpPdf, TRAVEL_DOCUMENT_PERMISSIONS } from '../documents/testing/compliance'
import { runCloseDays } from '../manifest/close-days'
import { createPickupRuntime, usePickups } from './runtime'

/**
 * Pickups and the day's close (B-W2b-395; LOG-048, LOG-049, LOG-053; Rule 1: the dock closes every day) on the local stack,
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security,
 * the grants, W1's shipping triggers and B-W2b-367's …_carriers_w2b_guards are real), the factory-db seeds of one tenant up to
 * money (SO-0002's released garments, with made-up releases of three more cells), sessions from the test authenticator, the
 * gateway (Redis limits, the call ledger), the local file store and the FAKE Sendcloud pickups. Every name and number is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/pickups`.
 *
 *   pickups      site A1 in test mode: a Sendcloud booking answered by the TEST pickup (nothing sent, no call); a recurring
 *                round only by phone with its note; live: refused in words without a connection, then booked through the FAKE
 *                (a call in the ledger), a weekend refused by the carrier and kept FAILED with why; failed and called off
 *                (Sendcloud told), confirmed by hand; what comes on a day; another company sees none
 *   end of day   SA (brt) left: listed, previewed, closed with its PDF and MANIFEST document, printed or said why not; SB packed
 *                at the dock is not on the sheet, leaves after the close and waits; the system closes the next day with it
 *   collection   SC the customer collects: refused to leave without who collected, the plate and the signed DDT; recorded
 *                (plate in capitals); leaves; DELIVERED at that time by the worker; fixed after
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let secrets: SecretsService
let files: FilesRuntime
let fake: FakeSendcloudPickups
let seedA: ShippingSeed

const ns = 'dispatch-day-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1') }
const YEAR = businessDate(new Date()).slice(0, 4)
const ZONE = 'Europe/Rome'

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.pickups.book']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId = newId()) => ({ audience: 'office' as const, tenantId: A.tenant, actorId, grants })
const DESK = office([grant([...SHIPPING, 'files.read', 'files.upload', 'print.view', 'print.documents'])])
const SESSIONS: Record<string, SessionContext> = {
  desk: DESK,
  viewer: office([grant(['shipping.view'])]),
  companyB: office([grant(SHIPPING, [A.companyB])]),
  quality: office([grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `dispatch-day-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const calls = async (operation: string) => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "IntegrationCall" WHERE operation = $1', [operation]))[0]!.n
const system = () => callerFor(database, systemContext(A.tenant, newId()))

/** The next day from tomorrow that is (or is not) a working weekday, at 10:00 on the site's clock. */
function nextDay(weekend: boolean): Date {
  for (let ahead = 1; ahead <= 8; ahead++) {
    const day = businessDate(new Date(Date.now() + ahead * 86_400_000), ZONE)
    const isWeekend = ['SATURDAY', 'SUNDAY'].includes(weekdayOf(day))
    if (isWeekend === weekend) return localInstant(day, 600, ZONE)
  }
  throw new Error('no such day')
}

async function addSendcloudAccount(): Promise<string> {
  const id = newId()
  await command(callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'made-up-dispatch-day-webhook-secret' })
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
  db = await migratedDatabase('dispatch_day')
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
  // Made-up releases of three more of SO-0002's cells (one garment each; the seed releases its BLK 52 only), past the release
  // guard, as made-up facts the seeds do not have.
  const passed = (await admin<{ inspectionId: string; workOrderId: string }>(`SELECT "inspectionId", "workOrderId" FROM "QualityRelease" WHERE "workOrderSizeId" = $1 LIMIT 1`, [seedA.quality.production.cellIds['BLK-52']]))[0]!
  await admin('SET session_replication_role = replica')
  for (const [cell, n] of [['BLK-54', 1], ['RED-54', 2], ['RED-50', 3]] as const) {
    await admin(
      `INSERT INTO "QualityRelease" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", number, "inspectionId", quantity, "releasedAt", "signatureSha256") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, now() - interval '1 hour', $9)`,
      [newId(), A.tenant, A.companyA, A.siteA1, passed.workOrderId, seedA.quality.production.cellIds[cell], `TEST-REL-395-${n}`, passed.inspectionId, 'b'.repeat(64)],
    )
  }
  await admin('SET session_replication_role = DEFAULT')

  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-dispatch-day-test-'))
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  fake = new FakeSendcloudPickups()
  const noNetwork = (async () => {
    throw new Error('a test never reaches the network')
  }) as typeof fetch
  usePickups(createPickupRuntime({ gateway, environment: 'test', fake, remote: sendcloudPickupsAdapter({ fetch: noNetwork }) }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
  await fileTravelDocuments(app, 'quality', seedA.quality.production.styleId, seedA.quality.production.revisionId)
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  usePickups(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const P: Record<string, string> = {}
const S: Record<string, string> = {}
const pickupsUrl = '/shipping/pickups'

describe('book a carrier pickup (LOG-048): a failure stays visible on the request', () => {
  it('in test mode the TEST pickup answers a Sendcloud booking: nothing sent, no call, no connection needed', async () => {
    const draft = await ok('desk', 'GET', `${pickupsUrl}/draft?siteId=${A.siteA1}`)
    expect(draft).toMatchObject({ siteId: A.siteA1, testMode: true, address: { name: expect.any(String), country: expect.any(String) }, vias: { SENDCLOUD: { allowed: true, test: true, recurring: false }, PHONE: { allowed: true, recurring: true } } })
    const readyAt = nextDay(false).toISOString()
    const booked = await ok('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'SENDCLOUD', carrierCode: 'brt', readyAt, parcels: 2, pallets: 0 }, 201)
    expect(booked.pickup).toMatchObject({ status: 'CONFIRMED', via: 'SENDCLOUD', test: true, providerReference: expect.stringMatching(/^TEST-PU-[0-9A-F]{10}$/), carrierName: 'BRT', parcels: 2, recurring: false, readyTime: '10:00', createdById: DESK.actorId })
    expect(booked.pickup.address).toEqual(draft.address)
    P.test = booked.pickup.id
    expect(await calls('carrier.book_pickup')).toBe(0)
    expect(fake.booked).toBe(0)
    const events = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.pickup_changed' AND subject = $1`, [P.test])
    expect(events.map((row) => row.payload.status)).toEqual(['CONFIRMED'])
  })

  it('keeps a recurring round only as booked by phone, with whom; refuses a recurring Sendcloud booking and a reader', async () => {
    const readyAt = nextDay(false).toISOString()
    const recurring = await refused('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'SENDCLOUD', carrierCode: 'brt', readyAt, parcels: 1, pallets: 0, repeatWeekdays: ['MONDAY'] }, 400)
    expect(recurring.issues.map((issue: Json) => issue.path)).toEqual(['body/repeatWeekdays'])
    expect((await refused('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'PHONE', carrierCode: 'gls', readyAt, parcels: 0, pallets: 1 }, 400)).issues[0].path).toBe('body/note')
    expect((await refused('viewer', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'PHONE', carrierCode: 'gls', readyAt, parcels: 0, pallets: 1, note: 'x' }, 403)).code).toBe('forbidden')
    const phone = await ok('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'PHONE', carrierCode: 'gls', readyAt, parcels: 0, pallets: 1, repeatWeekdays: ['FRIDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'], note: 'Booked with the made-up depot desk', providerReference: 'GLS-MADEUP-1' }, 201)
    expect(phone.pickup).toMatchObject({ status: 'CONFIRMED', via: 'PHONE', test: false, recurring: true, repeatWeekdays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], providerReference: 'GLS-MADEUP-1', pallets: 1 })
    P.phone = phone.pickup.id
    // What comes that day: the recurring round on its weekday, by its ready time; next week's same weekday too.
    const day = businessDate(new Date(readyAt), ZONE)
    const coming = (await ok('viewer', 'GET', `${pickupsUrl}?siteId=${A.siteA1}&day=${day}`)).pickups as Json[]
    expect(coming.map((row) => row.id)).toEqual(expect.arrayContaining([P.test, P.phone]))
    const later = (await ok('viewer', 'GET', `${pickupsUrl}?siteId=${A.siteA1}&day=${plusDays(day, 7)}`)).pickups as Json[]
    expect(later.map((row) => row.id)).toContain(P.phone)
    expect(later.map((row) => row.id)).not.toContain(P.test)
    expect((await ok('viewer', 'GET', `${pickupsUrl}/${P.phone}`)).pickup).toMatchObject({ readyTime: '10:00', note: 'Booked with the made-up depot desk' })
    expect((await refused('companyB', 'GET', `${pickupsUrl}/${P.phone}`, undefined, 404)).code).toBe('not_found')
  })

  it('live: refused in words without a Sendcloud connection (nothing kept), then booked through the FAKE; a weekend kept FAILED with why', async () => {
    await admin(`UPDATE "ShippingSettings" SET "testMode" = false, "liveSince" = now() - interval '1 hour', "liveSetById" = $1 WHERE id = $2`, [DESK.actorId, A.siteA1])
    const before = (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PickupRequest" WHERE "siteId" = $1`, [A.siteA1]))[0]!.n
    const readyAt = nextDay(false).toISOString()
    const none = await refusedFor('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'SENDCLOUD', carrierCode: 'brt', readyAt, parcels: 3, pallets: 0 }, 'NO_CONNECTION')
    expect(none.message).toMatch(/^A pickup is booked through the company's own Sendcloud connection/)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "PickupRequest" WHERE "siteId" = $1`, [A.siteA1]))[0]!.n).toBe(before)
    expect((await ok('desk', 'GET', `${pickupsUrl}/draft?siteId=${A.siteA1}`)).vias.SENDCLOUD).toMatchObject({ allowed: false, test: false, refusal: { code: 'NO_CONNECTION' } })

    await addSendcloudAccount()
    const live = await ok('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'SENDCLOUD', carrierCode: 'brt', readyAt, parcels: 3, pallets: 0, weightKg: '12.5' }, 201)
    expect(live.pickup).toMatchObject({ status: 'CONFIRMED', via: 'SENDCLOUD', test: false, providerReference: expect.stringMatching(/^FPU-[0-9A-F]{10}$/), errorWords: null })
    P.live = live.pickup.id
    expect(fake.pickupOf(live.pickup.providerReference)?.request).toMatchObject({ carrierCode: 'brt', parcels: 3, pallets: 0, weightKg: '12.5', readyFrom: readyAt })
    expect(await calls('carrier.book_pickup')).toBe(1)
    const moves = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.pickup_changed' AND subject = $1 ORDER BY "occurredAt", id`, [P.live])
    expect(moves.map((row) => row.payload.status)).toEqual(['REQUESTED', 'CONFIRMED'])

    const weekend = await ok('desk', 'POST', pickupsUrl, { siteId: A.siteA1, via: 'SENDCLOUD', carrierCode: 'brt', readyAt: nextDay(true).toISOString(), parcels: 1, pallets: 0 }, 201)
    expect(weekend.pickup).toMatchObject({ status: 'FAILED', providerReference: null, errorWords: expect.stringMatching(/does not collect at weekends/), may: { cancel: { allowed: false, refusal: { code: 'FINAL' } } } })
    P.weekend = weekend.pickup.id
    await refusedFor('desk', 'POST', `${pickupsUrl}/${P.weekend}/status`, { status: 'CANCELLED' }, 'FINAL')
    // The failure is listed with its words (newest first).
    const listed = (await ok('viewer', 'GET', `${pickupsUrl}?siteId=${A.siteA1}&status=FAILED`)).pickups as Json[]
    expect(listed.find((row) => row.id === P.weekend)).toMatchObject({ errorWords: expect.stringMatching(/weekends/) })
  })

  it('after the booking: failed with why, called off (Sendcloud told), confirmed by hand; a stale version refused', async () => {
    expect((await refused('desk', 'POST', `${pickupsUrl}/${P.phone}/status`, { status: 'FAILED' }, 400)).issues[0].path).toBe('body/words')
    const failed = await ok('desk', 'POST', `${pickupsUrl}/${P.phone}/status`, { status: 'FAILED', words: 'The made-up driver did not come' })
    expect(failed).toMatchObject({ pickup: { status: 'FAILED', errorWords: 'The made-up driver did not come', version: 2 }, carrier: null })
    const reference = (await ok('desk', 'GET', `${pickupsUrl}/${P.live}`)).pickup.providerReference
    expect((await refused('desk', 'POST', `${pickupsUrl}/${P.live}/status`, { status: 'CANCELLED', version: 1 }, 409)).code).toBe('conflict')
    const cancelled = await ok('desk', 'POST', `${pickupsUrl}/${P.live}/status`, { status: 'CANCELLED', words: 'Goods not ready' })
    expect(cancelled).toMatchObject({ pickup: { status: 'CANCELLED' }, carrier: { told: true, words: null } })
    expect(fake.pickupOf(reference)?.cancelled).toBe(true)
    expect(await calls('carrier.cancel_pickup')).toBe(1)
    // A request whose answer never came (a made-up REQUESTED row, as after a lost answer) is confirmed by hand.
    const lost = newId()
    await admin(`INSERT INTO "PickupRequest" (id, "tenantId", "companyId", "siteId", "carrierCode", "readyAt", parcels, pallets, address, status) VALUES ($1, $2, $3, $4, 'brt', $5, 1, 0, '{"name":"Made-up","line1":"Via Finta 1","postalCode":"00000","city":"Seedtown","country":"IT"}', 'REQUESTED')`, [lost, A.tenant, A.companyA, A.siteA1, nextDay(false)])
    await refusedFor('desk', 'POST', `${pickupsUrl}/${P.test}/status`, { status: 'CONFIRMED' }, 'NOT_REQUESTED')
    const confirmed = await ok('desk', 'POST', `${pickupsUrl}/${lost}/status`, { status: 'CONFIRMED', providerReference: 'BRT-BY-PHONE-9', words: 'Confirmed on the phone' })
    expect(confirmed.pickup).toMatchObject({ status: 'CONFIRMED', providerReference: 'BRT-BY-PHONE-9', via: 'SENDCLOUD' })
    expect((await admin(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'shipping.movePickup'`, [lost]))[0]!.after).toMatchObject({ status: 'CONFIRMED', words: 'Confirmed on the phone' })
  })
})

/** A shipment of SO-0002's cell, packed into one weighed parcel, its DDT issued. */
async function packedShipment(cell: keyof ShippingSeed['quality']['production']['cellIds'], extra: Json): Promise<Json> {
  const shipment = (await ok('desk', 'POST', '/shipping/shipments', { salesOrderId: seedA.quality.production.salesOrderId, lines: [{ workOrderSizeId: seedA.quality.production.cellIds[cell], quantity: 1 }], ...extra }, 201)).shipment
  const parcel = (await ok('desk', 'POST', `/shipping/packing/${shipment.id}/parcels`, { grossWeightKg: '2.5' }, 201)).parcelId
  await ok('desk', 'PUT', `/shipping/packing/${shipment.id}/lines/${shipment.lines[0].id}/parcel`, { parcelId: parcel })
  expect((await ok('desk', 'POST', `/shipping/packing/${shipment.id}/pack`, {})).shipment.status).toBe('PACKED')
  await ok('desk', 'POST', `/shipping/shipments/${shipment.id}/ddt`, {}, 201)
  return shipment
}

describe("the day's close (LOG-049): the dock closes every day", () => {
  const today = () => businessDate(new Date(), ZONE)
  const brtOf = (read: Json): Json => (read.carriers as Json[]).find((row) => row.carrierCode === 'brt')!

  it('lists what left with each carrier, previews the sheet, closes it with its PDF and MANIFEST document, and prints or says why not', async () => {
    const sa = await packedShipment('BLK-52', { carrierCode: 'brt', serviceCode: 'made-up-brt' })
    S.sa = sa.id
    const sb = await packedShipment('BLK-54', { carrierCode: 'brt', serviceCode: 'made-up-brt' })
    S.sb = sb.id
    expect((await ok('desk', 'POST', `/shipping/shipments/${sa.id}/ship`, {})).shipment.status).toBe('SHIPPED')

    const read = await ok('viewer', 'GET', `/shipping/end-of-day?siteId=${A.siteA1}`)
    expect(read).toMatchObject({ day: today(), today: today() })
    const brt = brtOf(read)
    expect(brt).toMatchObject({ carrierName: 'BRT', sheet: null, totals: { shipments: 1, parcels: 1, weightKg: '2.500' }, may: { close: { allowed: true, refusal: null } } })
    expect(brt.shipments.map((row: Json) => [row.id, row.parcels, row.weightKg, row.earlier])).toEqual([[sa.id, 1, '2.500', false]])
    expect(brt.shipments[0].ddtNumber).toMatch(/\/\d{4}$/)
    expect(brt.stillPacked.map((row: Json) => row.id)).toEqual([sb.id])
    expect(read.toClose).toContain('brt')

    const preview = await call('viewer', 'GET', `/shipping/end-of-day/preview?siteId=${A.siteA1}&carrierCode=brt`)
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers['content-type']).toMatch(/^application\/pdf/)
    expect(preview.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    await refusedFor('viewer', 'GET', `/shipping/end-of-day?siteId=${A.siteA1}&day=${plusDays(today(), 1)}`, undefined, 'FUTURE_DAY')
    expect((await refused('viewer', 'POST', '/shipping/end-of-day/close', { siteId: A.siteA1 }, 403)).code).toBe('forbidden')

    const closed = await ok('desk', 'POST', '/shipping/end-of-day/close', { siteId: A.siteA1 })
    const outcome = (closed.outcomes as Json[]).find((row) => row.carrierCode === 'brt')!
    expect(outcome).toMatchObject({ closed: true, shipments: 1, parcels: 1, letGo: [], printJob: null, printProblem: expect.stringMatching(/no document printer/) })
    S.sheet = outcome.manifestId
    const sheet = (await admin(`SELECT "closedAt", "closedById", "fileId", day::text AS day FROM "DispatchManifest" WHERE id = $1`, [S.sheet]))[0]!
    expect(sheet).toMatchObject({ closedById: DESK.actorId, fileId: outcome.fileId, day: today() })
    expect(await admin(`SELECT "manifestId" FROM "Shipment" WHERE id = $1`, [sa.id])).toEqual([{ manifestId: S.sheet }])
    expect(await admin(`SELECT kind::text AS kind, version, "fileId", "siteId" FROM "GeneratedDocument" WHERE "recordId" = $1`, [S.sheet])).toEqual([{ kind: 'MANIFEST', version: 1, fileId: outcome.fileId, siteId: A.siteA1 }])
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.day_sheet_closed' AND subject = $1`, [S.sheet]))[0]!.payload).toMatchObject({ carrierCode: 'brt', shipments: 1, parcels: 1, bySystem: false })

    const one = await ok('viewer', 'GET', `/shipping/manifests/${S.sheet}`)
    expect(one.manifest).toMatchObject({ state: 'CLOSED', closedBy: 'PERSON', carrierCode: 'brt', day: today(), fileId: outcome.fileId, documentId: outcome.documentId, totals: { shipments: 1 } })
    const pdf = await ok('desk', 'GET', `/shipping/manifests/${S.sheet}/pdf`)
    expect(pdf).toMatchObject({ file: { id: outcome.fileId, contentType: 'application/pdf', recordType: 'DispatchManifest' }, download: { method: 'GET', url: expect.any(String) } })
    expect((await refused('companyB', 'GET', `/shipping/manifests/${S.sheet}`, undefined, 404)).code).toBe('not_found')

    // A second close of the same carrier and day closes nothing more.
    const again = await ok('desk', 'POST', '/shipping/end-of-day/close', { siteId: A.siteA1, carrierCodes: ['brt'], print: false })
    expect(again.outcomes).toEqual([expect.objectContaining({ carrierCode: 'brt', closed: false, refusal: expect.objectContaining({ code: 'ALREADY_CLOSED' }) })])
    // The sheet and its shipments are fixed (the database's guard).
    await expect(admin(`UPDATE "Shipment" SET "manifestId" = NULL WHERE id = $1`, [sa.id])).rejects.toThrow()
  })

  it('a shipment that leaves after the close waits for the next sheet; the system closes the next day with it (closedById null)', async () => {
    expect((await ok('desk', 'POST', `/shipping/shipments/${S.sb}/ship`, {})).shipment.status).toBe('SHIPPED')
    const brt = brtOf(await ok('viewer', 'GET', `/shipping/end-of-day?siteId=${A.siteA1}`))
    expect(brt).toMatchObject({ sheet: { id: S.sheet, state: 'CLOSED', closedBy: 'PERSON' }, may: { close: { allowed: false, refusal: { code: 'ALREADY_CLOSED' } } } })
    expect(brt.shipments.map((row: Json) => row.id)).toEqual([S.sa])
    expect(brt.waiting.map((row: Json) => row.id)).toEqual([S.sb])

    // Two days on, the system closes the day after (its sheet takes the late hand-over); today's stays as it was.
    const later = fixedClock(new Date(Date.now() + 2 * 86_400_000))
    const tick = await runCloseDays({ database, log: { info() {}, warn() {}, error() {} }, clock: later, files })
    expect(tick).toMatchObject({ failed: 0 })
    const next = (await admin(`SELECT id, "closedById", "fileId", day::text AS day FROM "DispatchManifest" WHERE "siteId" = $1 AND "carrierCode" = 'brt' AND day = $2::date`, [A.siteA1, plusDays(today(), 1)]))[0]!
    expect(next).toMatchObject({ closedById: null, fileId: expect.any(String) })
    expect(await admin(`SELECT "manifestId" FROM "Shipment" WHERE id = $1`, [S.sb])).toEqual([{ manifestId: next.id }])
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.day_sheet_closed' AND subject = $1`, [next.id]))[0]!.payload).toMatchObject({ bySystem: true, shipments: 1 })
    // A second tick closes nothing more.
    expect((await runCloseDays({ database, log: { info() {}, warn() {}, error() {} }, clock: later, files })).closed).toBe(0)
  })
})

describe("the customer's own carrier collects (LOG-053; EXW / FCA)", () => {
  it('refuses to let the goods leave without who collected, the plate and the signed DDT; records them; delivered at the collection', async () => {
    const sc = await packedShipment('RED-54', { transportBy: 'RECIPIENT' })
    S.sc = sc.id
    const url = `/shipping/shipments/${sc.id}/collection`
    const empty = await ok('viewer', 'GET', url)
    expect(empty).toMatchObject({ applies: true, collectedByName: null, vehiclePlate: null, signature: null, missing: ['NAME', 'PLATE', 'SIGNATURE'], may: { record: { allowed: true }, leave: { allowed: false, refusal: { code: 'INCOMPLETE' } } }, ddt: { number: expect.any(String) } })
    expect(empty.incoterm).toMatchObject({ fits: expect.any(Boolean) })
    const blocked = await refusedFor('desk', 'POST', `/shipping/shipments/${sc.id}/ship`, {}, 'INCOMPLETE')
    expect(blocked.message).toMatch(/Still missing: who collected, the vehicle's plate, the DDT signed by the driver\.$/)

    expect((await refused('desk', 'PUT', url, { vehiclePlate: 'AB/12' }, 400)).issues[0].path).toBe('body/vehiclePlate')
    expect((await refused('desk', 'PUT', url, { signatureFileId: newId() }, 400)).issues[0].path).toBe('body/signatureFileId')
    expect((await refused('viewer', 'PUT', url, { vehiclePlate: 'AB123CD' }, 403)).code).toBe('forbidden')
    const signed = await storeGeneratedFile(files, callerFor(database, { ...DESK, requestId: newId() }), { companyId: A.companyA, recordType: 'Shipment', recordId: sc.id, kind: 'DOCUMENT', originalName: 'signed-ddt.pdf', contentType: 'application/pdf', body: madeUpPdf('the DDT signed by the made-up driver'), visibility: ['OFFICE'] })
    const recorded = await ok('desk', 'PUT', url, { collectedByName: '  Made-up   Driver ', vehiclePlate: 'ab 123  cd', signatureFileId: signed.id })
    expect(recorded).toMatchObject({ collectedByName: 'Made-up Driver', vehiclePlate: 'AB 123 CD', signature: { id: signed.id, name: 'signed-ddt.pdf' }, missing: [], may: { leave: { allowed: true } } })
    expect((await ok('desk', 'GET', `${url}/signature`)).download).toMatchObject({ method: 'GET' })

    expect((await ok('desk', 'POST', `/shipping/shipments/${sc.id}/ship`, {})).shipment.status).toBe('SHIPPED')
    // The worker: the collection is the delivery (at the time it left), once.
    const shipped = (await admin(`SELECT payload, id FROM "OutboxEvent" WHERE type = 'shipment.status_changed' AND subject = $1 ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [sc.id]))[0]!
    const handler = collectionDeliveredHandler()
    const handle = () => handler.handle({ eventId: shipped.id, type: 'shipment.status_changed', version: 1, tenantId: A.tenant, payload: shipped.payload } as never, { caller: system(), attempt: 1 } as never)
    await handle()
    await handle()
    const row = (await admin(`SELECT status::text AS status, "shippedAt", "deliveredAt" FROM "Shipment" WHERE id = $1`, [sc.id]))[0]!
    expect(row.status).toBe('DELIVERED')
    expect(row.deliveredAt.getTime()).toBe(row.shippedAt.getTime())
    expect(await admin(`SELECT status::text AS status, source::text AS source, "parcelId" FROM "TrackingEvent" WHERE "shipmentId" = $1`, [sc.id])).toEqual([{ status: 'DELIVERED', source: 'MANUAL', parcelId: null }])
    await refusedFor('desk', 'PUT', url, { vehiclePlate: 'ZZ999ZZ' }, 'LEFT')
    // A carrier shipment has no collection to record.
    await refusedFor('desk', 'PUT', `/shipping/shipments/${S.sa}/collection`, { vehiclePlate: 'AB123CD' }, 'LEFT')
    expect((await ok('viewer', 'GET', `/shipping/shipments/${S.sa}/collection`)).applies).toBe(false)
  })
})
