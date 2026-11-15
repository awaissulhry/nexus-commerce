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
import { seed as seedCarriers, type CarriersSeed } from '../../../../../../packages/factory-db/seed/carriers'
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
import { useSecrets } from '../../../platform/secrets/service'
import { readSecret, SECRET_PURPOSES, storeSecret } from '../../../platform/secrets/store'
import { addContract, changeContract } from '../carrier-accounts/contracts'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../documents/testing/compliance'
import { createCarrierRuntime, useCarrier } from '../labels/carrier'
import { setCarrierServices } from './plan'

/**
 * Carrier contracts and services (B-W2b-400; LOG-033, LOG-038, LOG-041, LOG-042; Owner answer Q20; Rule 1: express and export
 * parcels weekly, the customer's own account common in B2B) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants, B-W2b-367's
 * …_carriers_w2b_guards), the factory-db seeds of one tenant up to money and the carriers seed (company A's own "seed-express"
 * contract with "use only our rates", A1's insurance rule above 500.00, SH-0002's parcel declared and insured 520.00),
 * sessions from the test authenticator, real sealed secrets (a local key), the gateway, the local file store and the FAKE
 * Sendcloud. Every name, number and value is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/shipping/services`.
 *
 *   contracts   listed per site (the one a label uses), added (refused when a live one covers the scope, then a fresh step-up,
 *               the number sealed and never answered, audited or announced), "use only our rates", a new number (the old
 *               secret deleted), switched off for good
 *   customer    P1's own UPS account sealed, COLLECT, its default service; THIRD_PARTY; removed; refusals in words
 *   booking     SH-0002: who the carrier bills, the services with their state and cost in words, the values behind the grain
 *   services    express, the customer's carrier and service, an export's duties and paperless trade, refused in words where
 *               the carrier offers none or the shipment is no export
 *   values      a parcel's declared and insured values, the site's rule, by rule for every parcel
 *   live use    the services chosen on the Sendcloud connection (step-up); the label buy through the FAKE carries the
 *               booking; on a LIVE connection a service not chosen is refused before any call
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
let carriers: CarriersSeed

const ns = 'contracts-services-a'
const idOf = (key: string) => seedUuid(ns, key)
const A = { tenant: idOf('tenant'), companyA: idOf('company:A'), companyB: idOf('company:B'), siteA1: idOf('site:A1'), operator: idOf('worker:A1:operator'), P1: idOf('party:P1'), P2: idOf('party:P2') }
const YEAR = businessDate(new Date()).slice(0, 4)
const PRINTER = idOf('contracts-services:printer:A1')

const SHIPPING: Permission[] = ['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.labels.buy', 'shipping.labels.void', 'shipping.settings.view', 'shipping.settings.manage']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId = newId()) => ({ audience: 'office' as const, tenantId: A.tenant, actorId, grants })
const DESK = office([grant([...SHIPPING, 'parties.view', 'parties.manage', 'money.price', 'files.read', 'print.view', 'print.labels'])])
const SESSIONS: Record<string, SessionContext> = {
  desk: DESK,
  noPrice: office([grant([...SHIPPING, 'parties.view', 'parties.manage'])]),
  viewer: office([grant(['shipping.view', 'shipping.settings.view', 'parties.view'])]),
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
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `contracts-services-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const desk = () => callerFor(database, { ...DESK, requestId: newId() })
const noCode = () => {
  throw new StepUpRequiredError()
}
const calls = (operation: string) => admin<{ n: number }>('SELECT count(*)::int AS n FROM "IntegrationCall" WHERE operation = $1', [operation])
/** Nothing of a typed number reaches the audit, the outbox or the command receipts. */
async function nowhere(text: string): Promise<void> {
  expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "tenantId" = $1 AND (before::text LIKE $2 OR after::text LIKE $2)`, [A.tenant, `%${text}%`])).toEqual([{ n: 0 }])
  expect(await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE payload::text LIKE $1`, [`%${text}%`])).toEqual([{ n: 0 }])
}

async function addAccount(): Promise<string> {
  const id = newId()
  await command(callerFor(database, { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [], requestId: newId() }), { name: 'integration.createAccount', input: { id } }, async (tools) => {
    const webhook = await storeSecret(tools, secrets, { purpose: SECRET_PURPOSES.webhook, plaintext: 'made-up-contracts-services-webhook-secret' })
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
  db = await migratedDatabase('contracts_services')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: ns })
  seedA = (await seedMoney({ db: database, namespace: ns })).shipping
  carriers = await seedCarriers({ db: database, namespace: ns })
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT12345670009', "fiscalCode" = '12345670009', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [A.companyA])
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

  secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  useSecrets(secrets)
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-contracts-services-test-'))
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  fake = new FakeSendcloud()
  const noNetwork = (async () => {
    throw new Error('a test never reaches the network')
  }) as typeof fetch
  useCarrier(createCarrierRuntime({ gateway, environment: 'test', fake, remote: sendcloudAdapter({ fetch: noNetwork }) }))
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
  await fileTravelDocuments(app, 'quality', seedA.quality.serialStyleId, seedA.quality.serialRevisionId)
}, 180_000)

afterAll(async () => {
  useFiles(undefined)
  useCarrier(undefined)
  useSecrets(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const sh2 = () => seedA.draftShipmentId
const S: Record<string, any> = {}
const booking = (session = 'desk', shipmentId = sh2()) => ok(session, 'GET', `/shipping/shipments/${shipmentId}/booking`)
const contractsUrl = '/shipping/carrier-contracts'

describe('our own carrier contracts per company and site (LOG-033)', () => {
  it("lists the contracts a site's labels can use: the company's for every site; the switched-off one only on request", async () => {
    const listed = await ok('desk', 'GET', `${contractsUrl}?siteId=${A.siteA1}`)
    expect(listed.contracts.map((row: Json) => [row.id, row.siteId, row.carrierCode, row.ownRatesOnly, row.active, row.numberOnFile, row.usedForSite])).toEqual([[carriers.contractIds.companyA, null, 'seed-express', true, true, true, true]])
    expect(listed.contracts[0].words).toBe('Our own contract with Seed Express, for every site of the company: labels for it are bought only on this contract ("use only our rates").')
    const all = await ok('desk', 'GET', `${contractsUrl}?companyId=${A.companyA}&includeOff=true`)
    expect(all.contracts.map((row: Json) => [row.id, row.active, row.numberOnFile])).toEqual([
      [carriers.contractIds.companyA, true, true],
      [carriers.contractIds.oldA1, false, false],
    ])
    // Company B's desk reads company B's contract only; the floor never reaches the route.
    expect((await ok('companyB', 'GET', contractsUrl)).contracts.map((row: Json) => row.id)).toEqual([carriers.contractIds.companyB])
    expect((await refused('packerA1', 'GET', contractsUrl, undefined, 403)).code).toBe('forbidden')
  })

  it('adds a contract: refused in words when a live one covers the scope, then a fresh step-up; the number sealed, never answered nor kept in clear', async () => {
    await refusedFor('desk', 'POST', contractsUrl, { companyId: A.companyA, carrierCode: 'seed-express', accountNumber: 'MADE-UP-0001' }, 'LIVE_EXISTS')
    expect((await refused('viewer', 'POST', contractsUrl, { companyId: A.companyA, siteId: A.siteA1, carrierCode: 'brt', accountNumber: 'MADE-UP-0002' }, 403)).code).toBe('forbidden')
    expect((await refused('desk', 'POST', contractsUrl, { companyId: A.companyA, carrierCode: 'brt', accountNumber: 'x' }, 400)).issues[0].path).toBe('body/accountNumber')
    const body = { companyId: A.companyA, siteId: A.siteA1, carrierCode: ' BRT ', accountNumber: 'MADE-UP-BRT-1234', ownRatesOnly: false }
    // No fresh code: nothing written.
    await expect(addContract(secrets, desk(), body, noCode)).rejects.toBeInstanceOf(StepUpRequiredError)
    expect(await admin(`SELECT count(*)::int AS n FROM "CarrierAccount" WHERE "carrierCode" = 'brt'`)).toEqual([{ n: 0 }])

    const added = await addContract(secrets, desk(), body, () => {})
    expect(added).toMatchObject({ endsIn: '1234', contract: { companyId: A.companyA, siteId: A.siteA1, siteCode: 'A1', carrierCode: 'brt', carrierName: 'BRT', ownRatesOnly: false, active: true, numberOnFile: true, version: 1 } })
    expect(JSON.stringify(added.contract)).not.toContain('1234')
    S.brt = added.contract.id
    const sealed = (await admin<{ accountNumberSecretId: string }>(`SELECT "accountNumberSecretId" FROM "CarrierAccount" WHERE id = $1`, [S.brt]))[0]!.accountNumberSecretId
    expect(await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: DESK.actorId }, (client) => readSecret(client, secrets, { id: sealed, tenantId: A.tenant, purpose: 'shipping.carrier_account' }))).toBe('MADE-UP-BRT-1234')
    await nowhere('MADE-UP-BRT')
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.carrier_contract_changed'`)).toEqual([{ payload: { contractId: S.brt, siteId: A.siteA1, carrierCode: 'brt', change: 'ADDED' } }])
    // A1's labels with BRT now use A1's own contract.
    expect((await ok('desk', 'GET', `${contractsUrl}?siteId=${A.siteA1}&carrierCode=brt`)).contracts).toMatchObject([{ id: S.brt, usedForSite: true }])
  })

  it('switches "use only our rates" without a code, replaces the number after a fresh step-up (the old secret deleted), refuses a stale version', async () => {
    const rates = await ok('desk', 'PATCH', `${contractsUrl}/${S.brt}`, { version: 1, ownRatesOnly: true })
    expect(rates.contract).toMatchObject({ ownRatesOnly: true, version: 2 })
    expect(rates.endsIn).toBeNull()
    await refused('desk', 'PATCH', `${contractsUrl}/${S.brt}`, { version: 1, ownRatesOnly: false }, 409)
    const before = (await admin<{ accountNumberSecretId: string }>(`SELECT "accountNumberSecretId" FROM "CarrierAccount" WHERE id = $1`, [S.brt]))[0]!.accountNumberSecretId
    await expect(changeContract(secrets, desk(), S.brt, { version: 2, accountNumber: 'MADE-UP-BRT-9876' }, noCode)).rejects.toBeInstanceOf(StepUpRequiredError)
    const replaced = await changeContract(secrets, desk(), S.brt, { version: 2, accountNumber: 'MADE-UP-BRT-9876' }, () => {})
    expect(replaced).toMatchObject({ endsIn: '9876', contract: { numberOnFile: true, version: 3 } })
    expect(await admin(`SELECT count(*)::int AS n FROM "SecretValue" WHERE id = $1`, [before])).toEqual([{ n: 0 }])
    await nowhere('MADE-UP-BRT-9876')
    expect((await admin(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE type = 'shipping.carrier_contract_changed' ORDER BY "occurredAt"`)).map((row) => row.change)).toEqual(['ADDED', 'RATES_CHANGED', 'NUMBER_REPLACED'])
  })

  it('switches a contract off for good: its number removed, the row kept; it changes no more; a new contract may cover the scope again', async () => {
    const sealed = (await admin<{ accountNumberSecretId: string }>(`SELECT "accountNumberSecretId" FROM "CarrierAccount" WHERE id = $1`, [S.brt]))[0]!.accountNumberSecretId
    const off = await ok('desk', 'POST', `${contractsUrl}/${S.brt}/switch-off`, { version: 3 })
    expect(off.contract).toMatchObject({ active: false, numberOnFile: false, words: 'Our contract with BRT for A1: switched off, its number removed.' })
    expect(await admin(`SELECT count(*)::int AS n FROM "SecretValue" WHERE id = $1`, [sealed])).toEqual([{ n: 0 }])
    await refusedFor('desk', 'PATCH', `${contractsUrl}/${S.brt}`, { version: 4, ownRatesOnly: false }, 'SWITCHED_OFF')
    await refusedFor('desk', 'POST', `${contractsUrl}/${S.brt}/switch-off`, { version: 4 }, 'SWITCHED_OFF')
    const again = await addContract(secrets, desk(), { companyId: A.companyA, siteId: A.siteA1, carrierCode: 'brt', accountNumber: 'MADE-UP-BRT-5555' }, () => {})
    expect(again.contract).toMatchObject({ active: true, ownRatesOnly: false })
    // The database keeps the rule for any other writer: a second live contract of the same scope is refused there too.
    await expect(admin(`INSERT INTO "CarrierAccount" (id, "tenantId", "companyId", "siteId", "carrierCode", "accountNumberSecretId") SELECT $1, "tenantId", "companyId", "siteId", 'brt', NULL FROM "CarrierAccount" WHERE id = $2`, [newId(), again.contract.id])).rejects.toThrow(/CarrierAccount_one_live/)
  })
})

describe("the customer's carrier account (LOG-038)", () => {
  const url = `/shipping/customer-carrier-accounts`

  it("keeps P1's own UPS account sealed, COLLECT, its default service; then THIRD_PARTY; refusals in words", async () => {
    const start = (await ok('desk', 'GET', `${url}/${A.P1}`)).account
    expect(start).toMatchObject({ partyId: A.P1, carrierCode: null, accountOnFile: false, freightBilling: 'SENDER' })
    expect((await refused('desk', 'PUT', `${url}/${A.P1}`, { version: start.version, freightBilling: 'COLLECT' }, 400)).issues[0].path).toBe('body/freightBilling')
    expect((await refused('viewer', 'PUT', `${url}/${A.P1}`, { version: start.version, carrierCode: 'ups' }, 403)).code).toBe('forbidden')
    // A supplier keeps no freight account of a customer.
    const supplier = (await ok('desk', 'GET', `${url}/${A.P2}`)).account
    await refusedFor('desk', 'PUT', `${url}/${A.P2}`, { version: supplier.version, carrierCode: 'ups', accountNumber: 'MADE-UP-UPS-0000' }, 'NOT_A_CUSTOMER')

    const set = await ok('desk', 'PUT', `${url}/${A.P1}`, { version: start.version, carrierCode: 'UPS', accountNumber: 'MADE-UP-UPS-778899', freightBilling: 'COLLECT', defaultCarrierService: 'made-up-ups-saver' })
    expect(set).toMatchObject({ endsIn: '8899', account: { carrierCode: 'ups', carrierName: 'UPS', accountOnFile: true, freightBilling: 'COLLECT', defaultCarrierService: 'made-up-ups-saver', version: start.version + 1 } })
    const party = (await admin<{ carrierAccountSecretId: string }>(`SELECT "carrierAccountSecretId" FROM "Party" WHERE id = $1`, [A.P1]))[0]!
    expect(await admin(`SELECT purpose FROM "SecretValue" WHERE id = $1`, [party.carrierAccountSecretId])).toEqual([{ purpose: 'parties.carrier_account' }])
    await nowhere('MADE-UP-UPS-778899')
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'party.updated' AND subject = $1`, [A.P1])).map((row) => row.payload.fields)).toEqual([['preferredCarrierCode', 'carrierAccount', 'freightBilling', 'defaultCarrierService']])
    // Another carrier needs its own account.
    expect((await refused('desk', 'PUT', `${url}/${A.P1}`, { version: set.account.version, carrierCode: 'dhl_express' }, 400)).issues[0].path).toBe('body/accountNumber')
    const third = await ok('desk', 'PUT', `${url}/${A.P1}`, { version: set.account.version, freightBilling: 'THIRD_PARTY' })
    expect(third.account).toMatchObject({ freightBilling: 'THIRD_PARTY', accountOnFile: true })
    S.p1Version = third.account.version
  })

  it('removes the account: the freight back to us, its secret deleted; then puts it back for the booking', async () => {
    const secret = (await admin<{ carrierAccountSecretId: string }>(`SELECT "carrierAccountSecretId" FROM "Party" WHERE id = $1`, [A.P1]))[0]!.carrierAccountSecretId
    const removed = await ok('desk', 'PUT', `${url}/${A.P1}`, { version: S.p1Version, accountNumber: null })
    expect(removed.account).toMatchObject({ carrierCode: 'ups', accountOnFile: false, freightBilling: 'SENDER' })
    expect(await admin(`SELECT count(*)::int AS n FROM "SecretValue" WHERE id = $1`, [secret])).toEqual([{ n: 0 }])
    const back = await ok('desk', 'PUT', `${url}/${A.P1}`, { version: removed.account.version, accountNumber: 'MADE-UP-UPS-112233', freightBilling: 'COLLECT' })
    expect(back.account).toMatchObject({ accountOnFile: true, freightBilling: 'COLLECT', defaultCarrierService: 'made-up-ups-saver' })
  })
})

describe('the booking, its services and values (LOG-041, LOG-042)', () => {
  it("reads SH-0002's booking: our own contract (test mode), the customer paying another carrier, insured by the site's rule; values only with the grain", async () => {
    const read = await booking()
    expect(read).toMatchObject({
      shipment: { number: 'SEED-SH-0002', carrierCode: 'seed-express', express: false, dutyPayer: null, paperless: false },
      destination: { from: 'IT', to: 'IT', kind: 'DOMESTIC' },
      carrier: { known: false },
      testMode: true,
      billedTo: { kind: 'OWN_CONTRACT', contractId: carriers.contractIds.companyA },
      customer: { partyId: A.P1, carrierCode: 'ups', freightBilling: 'COLLECT', accountOnFile: true, applied: false },
      currency: 'EUR',
      companyCurrency: 'EUR',
      insureAbove: 50000,
      parcels: [{ seq: 1, labelled: false, declaredValue: 52000, insuredValue: 52000, rule: { insure: true, words: "Declared above 500.00 EUR: insured for its declared value by the site's rule." } }],
      insuredParcels: 1,
      insuredTotal: 52000,
      problems: [],
      bookable: true,
      may: { change: { allowed: true, refusal: null } },
    })
    expect(read.extras.map((extra: Json) => [extra.service, extra.state])).toEqual([
      ['OWN_CONTRACT', 'TEST'],
      ['INSURANCE', 'TEST'],
    ])
    expect(read.warnings.map((warning: Json) => warning.code)).toEqual(['CUSTOMER_PAYS_OTHER_CARRIER'])
    const blind = await booking('noPrice')
    expect(blind.parcels[0]).not.toHaveProperty('declaredValue')
    expect(blind).not.toHaveProperty('insuredTotal')
    expect(blind.parcels[0].rule.words).not.toMatch(/500/)
    expect((await refused('noPrice', 'PUT', `/shipping/shipments/${sh2()}/parcels/${seedA.draftParcelId}/value`, { declaredValue: 100 }, 403)).code).toBe('forbidden')
  })

  it('sets express; refuses an export’s services on a domestic shipment; takes the customer’s carrier and default service', async () => {
    await refusedFor('desk', 'PUT', `/shipping/shipments/${sh2()}/services`, { dutyPayer: 'SENDER' }, 'NOT_EXPORT')
    const express = await ok('desk', 'PUT', `/shipping/shipments/${sh2()}/services`, { express: true })
    expect(express.shipment.express).toBe(true)
    const defaults = await ok('desk', 'PUT', `/shipping/shipments/${sh2()}/services`, { customerDefaults: true })
    expect(defaults).toMatchObject({ shipment: { carrierCode: 'ups', carrierName: 'UPS', serviceCode: 'made-up-ups-saver', express: true }, billedTo: { kind: 'CUSTOMER_ACCOUNT', contractId: null }, customer: { applied: true }, carrier: { known: true }, warnings: [] })
    expect(defaults.extras.map((extra: Json) => extra.service)).toEqual(['CUSTOMER_ACCOUNT', 'EXPRESS', 'INSURANCE'])
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.services_changed' ORDER BY "occurredAt"`)).map((row) => [row.payload.carrierCode, row.payload.express])).toEqual([
      ['seed-express', true],
      ['ups', true],
    ])
  })

  it('an export says who pays the duties: refused in words until said; DDP and paperless with UPS', async () => {
    const shipTo = (await admin<{ shipTo: Json }>(`SELECT "shipTo" FROM "Shipment" WHERE id = $1`, [sh2()]))[0]!.shipTo
    await admin(`UPDATE "Shipment" SET "shipTo" = "shipTo" || '{"country": "CH", "postalCode": "8001", "city": "Made-up Zürich"}'::jsonb WHERE id = $1`, [sh2()])
    const exporting = await booking()
    expect(exporting).toMatchObject({ destination: { kind: 'EXPORT' }, bookable: false })
    expect(exporting.problems.map((problem: Json) => problem.code)).toEqual(['DUTY_PAYER_NEEDED'])
    const ddp = await ok('desk', 'PUT', `/shipping/shipments/${sh2()}/services`, { dutyPayer: 'SENDER', paperless: true })
    expect(ddp).toMatchObject({ shipment: { dutyPayer: 'SENDER', paperless: true }, problems: [], bookable: true })
    expect(ddp.extras.map((extra: Json) => extra.service)).toEqual(['CUSTOMER_ACCOUNT', 'EXPRESS', 'DUTIES_PAID', 'PAPERLESS', 'INSURANCE'])
    // Back home for the rest: the export's services are taken off first.
    await ok('desk', 'PUT', `/shipping/shipments/${sh2()}/services`, { dutyPayer: null, paperless: false })
    await admin(`UPDATE "Shipment" SET "shipTo" = $1::jsonb WHERE id = $2`, [JSON.stringify({ ...shipTo, phone: '+39 02 0000000' }), sh2()])
  })

  it("declares and insures a parcel by the site's rule; refuses insured above declared; the rule changes; by rule for every parcel", async () => {
    const parcelUrl = `/shipping/shipments/${sh2()}/parcels/${seedA.draftParcelId}/value`
    const low = await ok('desk', 'PUT', parcelUrl, { declaredValue: 30000 })
    expect(low.parcels[0]).toMatchObject({ declaredValue: 30000, insuredValue: null, rule: { insure: false } })
    const high = await ok('desk', 'PUT', parcelUrl, { declaredValue: 60000 })
    expect(high.parcels[0]).toMatchObject({ declaredValue: 60000, insuredValue: 60000, rule: { insure: true } })
    expect((await refused('desk', 'PUT', parcelUrl, { declaredValue: 60000, insuredValue: 70000 }, 400)).issues[0].path).toBe('body/insuredValue')
    expect(await admin(`SELECT after->'insuredValue' AS insured FROM "AuditLog" WHERE "recordType" = 'Parcel' AND "recordId" = $1 ORDER BY "at" DESC, id DESC LIMIT 1`, [seedA.draftParcelId])).toEqual([{ insured: { $money: 'price', value: 60000 } }])
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipment.parcel_values_changed' ORDER BY "occurredAt" DESC LIMIT 1`))[0]!.payload).toEqual({ shipmentId: sh2(), number: 'SEED-SH-0002', parcelIds: [seedA.draftParcelId], byRule: true })

    const rule = (await ok('desk', 'GET', `/shipping/sites/${A.siteA1}/insurance`)).rule
    expect(rule).toMatchObject({ insureAbove: 50000, currency: 'EUR', hasSettings: true })
    expect((await refused('noPrice', 'GET', `/shipping/sites/${A.siteA1}/insurance`, undefined, 403)).code).toBe('forbidden')
    const raised = await ok('desk', 'PUT', `/shipping/sites/${A.siteA1}/insurance`, { version: rule.version, insureAbove: 100000 })
    expect(raised.rule).toMatchObject({ insureAbove: 100000, words: 'No declared value yet: the site insures a parcel declared above 1000.00 EUR.' })
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.insurance_rule_changed'`))[0]!.payload).toEqual({ siteId: A.siteA1, ruleOn: true })
    const byRule = await ok('desk', 'POST', `/shipping/shipments/${sh2()}/parcel-values/by-rule`, {})
    expect(byRule.parcels[0]).toMatchObject({ declaredValue: 60000, insuredValue: null, rule: { insure: false } })
    await ok('desk', 'PUT', `/shipping/sites/${A.siteA1}/insurance`, { version: raised.rule.version, insureAbove: 50000 })
    const again = await ok('desk', 'POST', `/shipping/shipments/${sh2()}/parcel-values/by-rule`, {})
    expect(again.parcels[0]).toMatchObject({ declaredValue: 60000, insuredValue: 60000 })
  })
})

describe('live use: the services chosen on the Sendcloud connection, and the label buy (Q20)', () => {
  it('lists the connection’s services, none chosen; choosing asks a fresh step-up; the customer’s account cannot be chosen', async () => {
    S.account = await addAccount()
    const listed = (await ok('desk', 'GET', `/shipping/carrier-services?companyId=${A.companyA}`)).connections
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ accountId: S.account, mode: 'FAKE', contracts: [], words: expect.stringMatching(/^A FAKE connection/) })
    expect(listed[0].services.map((entry: Json) => [entry.service, entry.chosen, entry.mapped])).toEqual([
      ['OWN_CONTRACT', false, true],
      ['CUSTOMER_ACCOUNT', false, false],
      ['EXPRESS', false, true],
      ['DUTIES_PAID', false, true],
      ['PAPERLESS', false, true],
      ['INSURANCE', false, true],
    ])
    const version = listed[0].version as number
    expect((await refused('desk', 'PUT', `/shipping/carrier-services/${S.account}`, { version, services: ['CUSTOMER_ACCOUNT'], contracts: [] }, 400)).issues[0].path).toBe('body/services')
    const body = { version, services: ['INSURANCE' as const], contracts: [{ carrierCode: 'seed-express', providerContractId: 4242 }] }
    await expect(setCarrierServices(desk(), S.account, body, noCode)).rejects.toBeInstanceOf(StepUpRequiredError)
    const chosen = await setCarrierServices(desk(), S.account, body, () => {})
    expect(chosen.connection).toMatchObject({ services: expect.arrayContaining([expect.objectContaining({ service: 'INSURANCE', chosen: true })]), contracts: [{ carrierCode: 'seed-express', providerContractId: 4242 }] })
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'shipping.carrier_services_changed'`))[0]!.payload).toEqual({ accountId: S.account, services: ['INSURANCE'], contractCarriers: ['seed-express'] })
  })

  it('buys the labels through the FAKE: each request carries the booking (express, insured value, the customer’s account), the audit says who was billed', async () => {
    await admin(`UPDATE "ShippingSettings" SET "testMode" = false, "liveSince" = now() - interval '1 minute', "liveSetById" = $1 WHERE id = $2`, [DESK.actorId, A.siteA1])
    const [, second] = seedA.quality.serialIds
    const serial = (await admin<{ serial: string }>('SELECT serial FROM "GarmentSerial" WHERE id = $1', [second]))[0]!.serial
    await ok('desk', 'POST', `/shipping/packing/${sh2()}/serials`, { serial, parcelId: seedA.draftParcelId })
    await ok('desk', 'PATCH', `/shipping/packing/${sh2()}/parcels/${seedA.draftParcelId}`, { grossWeightKg: '1.85' })
    expect((await ok('packerA1', 'POST', `/shipping/packing/${sh2()}/pack`, {})).shipment.status).toBe('PACKED')
    await ok('desk', 'POST', `/shipping/shipments/${sh2()}/ddt`, {}, 201)
    // Once the labels are bought the booking changes no more (void them first).
    const bought = await ok('desk', 'POST', `/shipping/shipments/${sh2()}/labels`, {}, 201)
    expect(bought).toMatchObject({ testMode: false, problem: null })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]!.extras).toEqual({ express: true, dutyPayer: null, paperless: false, declaredValue: '600.00', insuredValue: '600.00', currency: 'EUR', contract: null, billing: 'COLLECT' })
    expect(await admin(`SELECT after FROM "AuditLog" WHERE action = 'shipping.bookedWith' AND "recordId" = $1`, [sh2()])).toEqual([
      { after: { parcelIds: [seedA.draftParcelId], billedTo: 'CUSTOMER_ACCOUNT', contractId: null, services: [{ service: 'CUSTOMER_ACCOUNT', state: 'FAKE' }, { service: 'EXPRESS', state: 'FAKE' }, { service: 'INSURANCE', state: 'FAKE' }], destination: 'DOMESTIC' } },
    ])
    expect((await admin<{ requestSummary: Json }>(`SELECT "requestSummary" FROM "IntegrationCall" WHERE operation = 'carrier.create_label'`))[0]!.requestSummary).toMatchObject({ booking: { express: true, insured: true, ownContract: false, billing: 'COLLECT' } })
    await refusedFor('desk', 'PUT', `/shipping/shipments/${sh2()}/services`, { express: false }, 'LABELLED')
    await refusedFor('desk', 'PUT', `/shipping/shipments/${sh2()}/parcels/${seedA.draftParcelId}/value`, { declaredValue: 1000 }, 'LABELLED')
  })

  it('on a LIVE connection a service not chosen is refused in words before any call, nothing bought', async () => {
    await ok('desk', 'POST', `/shipping/shipments/${sh2()}/parcels/${seedA.draftParcelId}/label/void`, { reason: 'Made-up: booked again on the live connection' })
    await admin(`UPDATE "IntegrationAccount" SET mode = 'LIVE' WHERE id = $1`, [S.account])
    const before = (await calls('carrier.create_label'))[0]!.n
    const read = await booking()
    expect(read.problems.map((problem: Json) => problem.code)).toEqual(['SERVICE_NOT_CHOSEN', 'SERVICE_NOT_CHOSEN'])
    expect(read.extras.map((extra: Json) => [extra.service, extra.state])).toEqual([
      ['CUSTOMER_ACCOUNT', 'NOT_CHOSEN'],
      ['EXPRESS', 'NOT_CHOSEN'],
      ['INSURANCE', 'CHOSEN'],
    ])
    const error = await refusedFor('desk', 'POST', `/shipping/shipments/${sh2()}/labels`, {}, 'SERVICE_NOT_CHOSEN')
    expect(error.message).toMatch(/stays on the fake until the Owner chooses it/)
    expect(await calls('carrier.create_label')).toEqual([{ n: before }])
    expect(fake.requests).toHaveLength(1)
    await admin(`UPDATE "IntegrationAccount" SET mode = 'FAKE' WHERE id = $1`, [S.account])
  })
})
