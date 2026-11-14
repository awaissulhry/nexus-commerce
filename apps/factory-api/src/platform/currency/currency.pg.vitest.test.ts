import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { convertMinor } from '@nexus/factory-domain/money/currency/convert'
import { addDays } from '@nexus/factory-domain/money/currency/rates'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { FakeEcb } from '../../adapters/ecb/fake'
import { buildApp } from '../../core/app'
import { callerFor, command } from '../../core/command'
import { completeContext, testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { readAmounts } from '../../modules/sales/credit/reading'
import { subcontractCostPlan } from '../../modules/purchasing/subcontracting/cost-source'
import { ratesBeside } from '../../modules/purchasing/po-depth/beside'
import { takeDayRate } from '../../modules/purchasing/po-depth/value'
import { applySystemRoleChanges, systemRoleChanges } from '../auth/roles/system-roles'
import { startHarness, type Harness } from '../auth/sessions/testing/harness'
import { createGateway } from '../gateway/gateway'
import { createEcbRuntime, runEcbDaily, useEcb } from './feed'
import { dayRate, invoiceRateOf } from './service'

/**
 * Currencies and exchange rates (B-W2b-389; PLT-132, PLT-133; CY1:01-04) on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_tax_currency_w2b_guards triggers are real), tenant A from EVERY seed (company A: EUR base, CHF off, USD and GBP on; the
 * ECB's EUR→USD and EUR→GBP of a few days). The ECB file is the FAKE (no network): its answers are scripted. Test sessions
 * hold the role templates' grants. Every rate, name and number is made up; the tests use currencies the seed has no rate of
 * (JPY, SEK, NOK, CHF; AED for a currency with no ECB rate at all), so the seeded days never get in the way.
 *
 * What it walks: the company's currencies (read, add, switch, the base never off, refusals in words); the daily ECB switch
 * (a FAKE account made, paused), "read today's rates" (rows once, again nothing), the daily job (only where on); the rates
 * table with a manual rate of a day winning, corrected with its version, removed (back to the ECB's), the refusals (future
 * day, ECB row, a role over one company, a buyer); the day's rate across the euro; and the four follow-ups — a purchase
 * order takes the day's rate (CY1:01), the rates beside it (CY1:02), a subcontract fee in the work order's currency
 * (CY1:03), credit exposure across currencies (CY1:04) — and an invoice's euro rate.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/currency`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'currency-389'
const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B') }

const PEOPLE = { finance: newId(), buyer: newId(), sales: newId(), warehouse: newId(), financeA: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { finance: 'finance', buyer: 'buyer', sales: 'sales', warehouse: 'warehouse', financeA: 'finance' }

function grantsOf(role: string, companies: 'all' | string[] = 'all'): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies, sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}

let h: Harness
let app: FastifyInstance
let fake: FakeEcb
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await h.db.admin.query('SET session_replication_role = replica')
  try {
    await h.db.admin.query(sql, values)
  } finally {
    await h.db.admin.query('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b389-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const officeCaller = (person: Person) => callerFor(h.database, completeContext(SESSIONS[person]!, `test-${run}-${++keys}`))
const quiet = { info() {}, warn() {}, error() {} }

const today = () => businessDate(new Date())
// SEED-SC-0002 was issued on 2026-11-17: a rate kept on that day or before (never a future day) is its day's rate.
const scDay = () => (today() < '2026-11-17' ? today() : '2026-11-17')

beforeAll(async () => {
  h = await startHarness('currency_w2b389')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (currencies.* for finance, the administrator; view for buyer and sales).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], A.tenant, `w2b389-${person}-${run}@example.com`, `Made-up ${person}`])
    SESSIONS[person] = { audience: 'office', tenantId: A.tenant, actorId: PEOPLE[person], grants: grantsOf(role, person === 'financeA' ? [A.companyA] : 'all') }
  }
  fake = new FakeEcb()
  useEcb(createEcbRuntime({ gateway: createGateway({ environment: 'test', redis: h.redis, prefix: `${h.redisPrefix}_ecb`, secrets: h.secrets, sleep: async () => {}, log: quiet }), fake }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  useEcb(undefined)
  await app?.close()
  await h?.close()
}, 60_000)

describe("a company's currencies (PLT-132)", () => {
  it('reads the base and document currencies, adds one, switches, never switches the base off', async () => {
    const read = await ok('finance', 'GET', `/currencies?companyId=${A.companyA}`)
    expect(read.company).toMatchObject({ id: A.companyA, base: 'EUR' })
    expect(read.currencies.map((entry: Json) => [entry.code, entry.active, entry.base])).toEqual([
      ['EUR', true, true],
      ['GBP', true, false],
      ['USD', true, false],
      ['CHF', false, false],
    ])
    expect(read.offered).toEqual(expect.arrayContaining(['JPY', 'CHF', 'SEK']))
    expect(read.offered).not.toContain('USD')
    expect(read.feed).toMatchObject({ on: false, status: 'NONE' })
    expect(read.can).toEqual({ manage: true, manageRates: true })

    const jpy = (await ok('finance', 'POST', '/currencies', { companyId: A.companyA, code: 'jpy' }, 201)).currency
    expect(jpy).toMatchObject({ code: 'JPY', minorUnits: 0, active: true, base: false, rate: null })
    expect(jpy.waits).toMatch(/^No exchange rate of EUR to JPY for \d{4}-\d{2}-\d{2} or the 7 days before/)
    expect((await no('finance', 'POST', '/currencies', { companyId: A.companyA, code: 'JPY' }, 409)).message).toBe('JPY is one of the company\'s currencies already.')
    expect((await no('finance', 'POST', '/currencies', { companyId: A.companyA, code: 'BGN' }, 400)).message).toMatch(/BGN has no ECB reference rate/)
    await no('sales', 'POST', '/currencies', { companyId: A.companyA, code: 'SEK' }, 403)
    await no('warehouse', 'GET', `/currencies?companyId=${A.companyA}`, undefined, 403)

    // CHF was switched off: adding it switches the same row on again.
    const chfBefore = read.currencies.find((entry: Json) => entry.code === 'CHF')
    const chf = (await ok('finance', 'POST', '/currencies', { companyId: A.companyA, code: 'CHF' }, 201)).currency
    expect(chf).toMatchObject({ id: chfBefore.id, active: true })
    const off = (await ok('finance', 'POST', `/currencies/${chf.id}/switch`, { version: chf.version, active: false })).currency
    expect(off.active).toBe(false)
    expect((await no('finance', 'POST', `/currencies/${chf.id}/switch`, { version: chf.version, active: true }, 409)).code).toBe('conflict')
    const eur = read.currencies.find((entry: Json) => entry.code === 'EUR')
    expect((await no('finance', 'POST', `/currencies/${eur.id}/switch`, { version: eur.version, active: false }, 409)).message).toBe("EUR is the company's own currency: it is never switched off.")
    expect((await outbox('currency.changed')).map((event) => [event.code, event.action])).toEqual([
      ['JPY', 'ADDED'],
      ['CHF', 'SWITCHED_ON'],
      ['CHF', 'SWITCHED_OFF'],
    ])
  })
})

describe('the daily ECB rates (PLT-133)', () => {
  it('are off until switched on; a read keeps each day once; the job reads only where on', async () => {
    expect((await no('finance', 'POST', '/exchange-rates/fetch', {}, 409)).message).toBe('The daily ECB rates are off: switch them on first.')
    await no('buyer', 'PUT', '/exchange-rates/feed', { on: true }, 403)
    await no('financeA', 'PUT', '/exchange-rates/feed', { on: true }, 403)
    const on = (await ok('finance', 'PUT', '/exchange-rates/feed', { on: true })).feed
    expect(on).toMatchObject({ on: true, status: 'ACTIVE', mode: 'FAKE' })
    expect(await one(`SELECT provider::text, "companyId", mode::text, code, "rateLimitBurst" FROM "IntegrationAccount" WHERE id = $1`, [on.accountId])).toEqual({ provider: 'ECB', companyId: null, mode: 'FAKE', code: 'ecb', rateLimitBurst: 5 })
    // The test reads the file more often than a person would: a wider rate limit than the account's own (5 at once).
    await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE id = $1`, [on.accountId])

    const yesterday = addDays(today(), -1)
    fake.answerNext([
      { day: today(), rates: [{ currency: 'JPY', rate: '160.00' }, { currency: 'SEK', rate: '11.50' }] },
      { day: yesterday, rates: [{ currency: 'JPY', rate: '159.00' }, { currency: 'SEK', rate: '11.40' }] },
    ])
    const first = await ok('finance', 'POST', '/exchange-rates/fetch', {})
    expect(first).toMatchObject({ fileDays: [today(), yesterday], addedDays: [yesterday, today()], rows: 4 })
    expect(first.feed.lastEcbDay).toBe(today())
    fake.answerNext([{ day: today(), rates: [{ currency: 'JPY', rate: '160.00' }, { currency: 'SEK', rate: '11.50' }] }])
    expect(await ok('finance', 'POST', '/exchange-rates/fetch', {})).toMatchObject({ addedDays: [], rows: 0 })
    // The fake fails three times (the gateway's attempts): nothing kept, said in words.
    fake.failNext(3)
    expect((await no('finance', 'POST', '/exchange-rates/fetch', {}, 409)).message).toMatch(/^The ECB file could not be read now .*try again later\.$/)
    expect((await outbox('currency.rates_changed')).map((event) => [event.action, event.rows])).toEqual([
      ['FEED_ON', 0],
      ['ECB_READ', 4],
    ])
    expect(await admin(`SELECT key FROM "ExchangeRate" WHERE "tenantId" = $1 AND quote = 'JPY' AND source = 'ECB' ORDER BY key`, [A.tenant])).toEqual([{ key: `EUR:JPY:${yesterday}:ECB` }, { key: `EUR:JPY:${today()}:ECB` }])

    // The job: the tenant is on, so it reads (the fake's own made-up file: the last weekday).
    const said: unknown[] = []
    const log = { info() {}, warn: (...args: unknown[]) => said.push(args), error: (...args: unknown[]) => said.push(args) }
    const job = await runEcbDaily({ database: h.database, log, runtime: () => createEcbRuntime({ gateway: createGateway({ environment: 'test', redis: h.redis, prefix: `${h.redisPrefix}_job`, secrets: h.secrets, sleep: async () => {}, log: quiet }), fake }) })
    expect(job, JSON.stringify(said, (_, value) => (value instanceof Error ? `${value.name}: ${value.message}` : value))).toMatchObject({ read: 1, failed: 0 })
    const off = (await ok('finance', 'PUT', '/exchange-rates/feed', { on: false })).feed
    expect(off).toMatchObject({ on: false, status: 'PAUSED' })
    expect(await ok('finance', 'PUT', '/exchange-rates/feed', { on: false })).toMatchObject({ feed: { status: 'PAUSED' } })
    const later = await runEcbDaily({ database: h.database, log: quiet })
    expect(later.read).toBe(0)
    expect(later.off).toBeGreaterThanOrEqual(1)
    expect((await no('finance', 'POST', '/exchange-rates/fetch', {}, 409)).message).toBe('The daily ECB rates are off: switch them on first.')
  })
})

describe('the rates table and a manual rate per day (PLT-133)', () => {
  it('a manual rate of a day wins, is corrected with its version and removed back to the ECB rate', async () => {
    const set = (await ok('finance', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: today(), rate: '161.25' })).day
    expect(set).toMatchObject({ base: 'EUR', quote: 'JPY', day: today(), ecb: { rate: '160' }, manual: { rate: '161.25', version: 1, overriddenBy: { id: PEOPLE.finance, name: 'Made-up finance' } }, rate: '161.25', source: 'MANUAL', words: '1 EUR = 161.25 JPY', farFromEcb: false })
    expect((await no('finance', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: today(), rate: '161.30' }, 409)).message).toMatch(/is kept already \(1 EUR = 161.25 JPY\): correct that one/)
    const corrected = (await ok('finance', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: today(), rate: '190', version: 1 })).day
    expect(corrected).toMatchObject({ manual: { rate: '190', version: 2 }, farFromEcb: true })
    expect((await no('finance', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: today(), rate: '191', version: 1 }, 409)).code).toBe('conflict')
    expect((await no('finance', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: addDays(today(), 1), rate: '160' }, 400)).message).toBe('A rate is kept for today or a day before: the future has no rate yet.')
    expect((await no('finance', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: today(), rate: '0' }, 400)).message).toMatch(/above 0/)
    await no('buyer', 'PUT', '/exchange-rates/manual', { quote: 'JPY', day: today(), rate: '160' }, 403)
    expect((await no('financeA', 'PUT', '/exchange-rates/manual', { quote: 'SEK', day: today(), rate: '11' }, 403)).message).toBe('The exchange rates serve every company: they are changed only by a role over every company.')

    const table = await ok('buyer', 'GET', '/exchange-rates?quote=JPY')
    expect(table.canManage).toBe(false)
    expect(table.days.map((entry: Json) => [entry.day, entry.source, entry.rate])).toEqual([
      [today(), 'MANUAL', '190'],
      [addDays(today(), -1), 'ECB', '159'],
    ])
    expect((await ok('sales', 'GET', `/exchange-rates/day?quote=JPY&day=${today()}`)).rate).toMatchObject({ rate: '190.00000000', source: 'MANUAL', words: '1 EUR = 190 JPY' })
    // Across the euro: 1 SEK = 190 ÷ 11.50 JPY = 16.52173913.
    expect((await ok('sales', 'GET', `/exchange-rates/day?base=SEK&quote=JPY&day=${today()}`)).rate).toMatchObject({ rate: '16.52173913', how: 'CROSS', source: 'MANUAL' })
    // A currency without an ECB rate (the job above kept every ECB currency of the fake's day) and no manual one: none.
    expect((await ok('sales', 'GET', '/exchange-rates/day?quote=AED')).waits).toMatch(/^No exchange rate of EUR to AED/)

    const ecbRow = table.days[0].ecb
    expect((await no('finance', 'DELETE', `/exchange-rates/manual/${ecbRow.id}?version=1`, undefined, 409)).message).toMatch(/ECB's rate of the day/)
    const back = (await ok('finance', 'DELETE', `/exchange-rates/manual/${corrected.manual.id}?version=2`)).day
    expect(back).toMatchObject({ source: 'ECB', rate: '160', manual: null })
    // The database holds the same rules for every login: an ECB rate never changes.
    await expect(admin(`UPDATE "ExchangeRate" SET rate = 1 WHERE id = $1`, [ecbRow.id])).rejects.toThrow(/never changes/)
    expect((await outbox('currency.rates_changed')).filter((event) => event.action.startsWith('MANUAL')).map((event) => [event.action, event.quote])).toEqual([
      ['MANUAL_SET', 'JPY'],
      ['MANUAL_SET', 'JPY'],
      ['MANUAL_REMOVED', 'JPY'],
    ])
  })
})

describe('the follow-ups (CY1:01-04) and the invoice', () => {
  let siteA1: string
  let supplier: string
  let item: string

  beforeAll(async () => {
    siteA1 = (await one<{ id: string }>(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND "companyId" = $2 ORDER BY code LIMIT 1`, [A.tenant, A.companyA])).id
    supplier = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND 'SUPPLIER' = ANY(roles::text[]) AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [A.tenant])).id
    item = (await one<{ id: string }>(`SELECT id FROM "Item" WHERE "tenantId" = $1 AND kind <> 'FINISHED' AND status = 'ACTIVE' ORDER BY code LIMIT 1`, [A.tenant])).id
  })

  const draftIn = async (currency: string) => {
    const orderId = newId()
    await force(
      `INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", status, kind, currency, "netAmount") VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', 'STANDARD', $8, 32000)`,
      [orderId, A.tenant, A.companyA, siteA1, `W2B389-${currency}-${run}`, supplier, today(), currency],
    )
    await force(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate") VALUES ($1, $2, $3, $4, $5, 10, $6, 10, 'PCS', 10, 3200, 32000, $7)`,
      [newId(), A.tenant, orderId, supplier, siteA1, item, addDays(today(), 30)],
    )
    return orderId
  }

  it('CY1:01 — a purchase order in another currency takes the day rate unless one is typed', async () => {
    const jpy = await draftIn('JPY')
    const depth = (await ok('buyer', 'GET', `/purchasing/orders/${jpy}/depth`)).depth
    expect(depth.currency).toMatchObject({ order: 'JPY', company: 'EUR', takesRate: true, rateAtOrder: null, dayRate: { rate: '160.00000000', rateDate: today(), source: 'ECB', words: '1 EUR = 160 JPY' } })
    const check = await ok('buyer', 'GET', `/purchasing/orders/${jpy}/send-check`)
    expect(check.checks.map((entry: Json) => entry.code)).not.toContain('NO_RATE_AT_ORDER')
    const dirham = await draftIn('AED')
    const refused = await ok('buyer', 'GET', `/purchasing/orders/${dirham}/send-check`)
    expect(refused.checks.find((entry: Json) => entry.code === 'NO_RATE_AT_ORDER')?.message).toMatch(/keep the day's rate in Finance › Settings › Currencies & rates/)
    // The send's own step: the day's rate kept with the order (32,000 yen at 160: 200.00 EUR) and an audit row saying so.
    await command(officeCaller('buyer'), { name: 'test.takeDayRate', input: { jpy } }, async (tools) => {
      await takeDayRate(tools, jpy)
      await tools.tx.purchaseOrder.update({ where: { id: jpy }, data: { companyNetAmount: convertMinor(32000, 'JPY', 'EUR', { base: 'EUR', quote: 'JPY', rate: '160' }) }, select: { id: true } })
      return null
    })
    expect(await one(`SELECT "rateAtOrder"::text AS rate, "companyNetAmount" AS value FROM "PurchaseOrder" WHERE id = $1`, [jpy])).toEqual({ rate: '160.00000000', value: 20000 })
    expect((await one<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.rate' ORDER BY at DESC LIMIT 1`, [jpy])).after).toMatchObject({ rateAtOrder: '160.00000000', taken: 'DAY_RATE', source: 'ECB' })
    // A typed rate stays the override: the step leaves it.
    await command(officeCaller('buyer'), { name: 'test.takeDayRate', input: { jpy, again: true } }, async (tools) => {
      await takeDayRate(tools, jpy)
      // The step itself records nothing when it leaves the rate: the test's own row.
      tools.audit({ recordType: 'PurchaseOrder', recordId: jpy, after: { checked: 'the rate at order stays' } })
      return null
    })
    expect((await one<{ rate: string }>(`SELECT "rateAtOrder"::text AS rate FROM "PurchaseOrder" WHERE id = $1`, [jpy])).rate).toBe('160.00000000')
  })

  it('CY1:02 — the day rates of the receipts and supplier invoices beside the rate at order', async () => {
    const received = await one<{ purchaseOrderId: string; receivedAt: Date; number: string }>(`SELECT "purchaseOrderId", "receivedAt", number FROM "GoodsReceipt" WHERE "tenantId" = $1 AND "purchaseOrderId" IS NOT NULL AND status <> 'CANCELLED' ORDER BY "receivedAt" DESC LIMIT 1`, [A.tenant])
    const day = businessDate(received.receivedAt)
    if (day <= today()) await ok('finance', 'PUT', '/exchange-rates/manual', { quote: 'SEK', day, rate: '11.111' })
    const { beside, expected } = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: PEOPLE.finance }, async (client) => ({ beside: await ratesBeside(client, received.purchaseOrderId, 'EUR', 'SEK'), expected: await dayRate(client, 'EUR', 'SEK', day) }))
    const receipt = beside.find((entry) => entry.at === 'RECEIPT' && entry.number === received.number)!
    expect(receipt.day).toBe(day)
    // The receipt's day's rate, as every document of that day takes it (a seeded receipt may be dated after today: then
    // the last rate kept within the 7 days before it).
    expect(receipt).toMatchObject({ rate: expected?.rate ?? null, source: expected?.source ?? null })
    if (day <= today()) expect(receipt).toMatchObject({ rate: '11.11100000', source: 'MANUAL', words: '1 EUR = 11.111 SEK' })
  })

  it('CY1:03 — a subcontract fee in another currency posts in the work order currency at the order rate', async () => {
    const order = await one<{ id: string; workOrderId: string }>(`SELECT id, "workOrderId" FROM "SubcontractOrder" WHERE "tenantId" = $1 AND number = 'SEED-SC-0002'`, [A.tenant])
    await ok('finance', 'PUT', '/exchange-rates/manual', { quote: 'NOK', day: scDay(), rate: '11.75' })
    const plan = (currency: string) => h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: PEOPLE.finance }, (client) => subcontractCostPlan(client, { id: order.workOrderId, currency }, [order.id], [], () => newId()))
    const inEuro = await plan('EUR')
    const inKrone = await plan('NOK')
    const fee = (drafts: readonly Json[]) => drafts.filter((entry) => entry.sourceType === 'SubcontractOperation').reduce((sum, entry) => sum + entry.amount, 0)
    // The work order in krone: the order (in euro) converts at 1 NOK = 1 ÷ 11.75 EUR, i.e. euro × 11.75.
    expect(fee(inKrone.drafts)).toBe(convertMinor(fee(inEuro.drafts), 'EUR', 'NOK', { base: 'EUR', quote: 'NOK', rate: '11.75' }))
    expect(inKrone.waiting).toEqual([])
    if (inKrone.drafts.length > 0) expect(inKrone.drafts[0]!.reason).toMatch(/; in NOK at 1 NOK = 0\.08510638 EUR of /)
    // No rate of the order's day for another currency (no ECB rate of the dirham): it waits, in words.
    const waits = await plan('AED')
    expect(waits.drafts.filter((entry) => entry.sourceType === 'SubcontractOperation')).toEqual([])
    if (fee(inEuro.drafts) !== 0) expect(waits.waiting[0]?.words).toMatch(/No exchange rate of AED to EUR/)
  })

  it('CY1:04 — credit exposure counts other currencies at the day rate, or leaves them out', async () => {
    const p1 = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [A.tenant])).id
    const read = (currency: string) => h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: PEOPLE.finance }, (client) => readAmounts(client, { partyId: p1, companyId: A.companyA, currency, limit: null, now: new Date() }))
    const euro = await read('EUR')
    const yen = await read('JPY')
    // The customer's euro orders and invoices in yen at today's ECB rate (1 EUR = 160 JPY).
    expect(yen.openOrders).toBe(convertMinor(euro.openOrders, 'EUR', 'JPY', { base: 'EUR', quote: 'JPY', rate: '160' }))
    expect(yen.openInvoices).toBe(convertMinor(euro.openInvoices, 'EUR', 'JPY', { base: 'EUR', quote: 'JPY', rate: '160' }))
    // No rate of the day: left out, as before.
    expect(await read('AED')).toMatchObject({ openOrders: 0, openInvoices: 0 })
  })

  it('an invoice in another currency keeps the euro rate, its day and its euro total, or waits for a rate', async () => {
    const invoice = await one<{ id: string; grossTotal: number }>(`SELECT id, "grossTotal" FROM "Invoice" WHERE "tenantId" = $1 AND currency = 'EUR' ORDER BY "createdAt" LIMIT 1`, [A.tenant])
    const rate = await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: PEOPLE.finance }, async (client) => ({
      eur: await invoiceRateOf(client, { id: invoice.id, currency: 'EUR', grossTotal: 12_200 }, today()),
      yen: await invoiceRateOf(client, { id: invoice.id, currency: 'JPY', grossTotal: 32_000 }, today()),
      dirham: await invoiceRateOf(client, { id: invoice.id, currency: 'AED', grossTotal: 32_000 }, today()),
      day: await dayRate(client, 'EUR', 'JPY', today()),
    }))
    expect(rate.eur).toBeNull()
    expect(rate.yen).toEqual({ ok: true, exchangeRate: '160.00000000', rateDate: today(), totalEur: 20_000, words: '1 EUR = 160 JPY' })
    expect(rate.dirham).toMatchObject({ ok: false, code: 'NO_RATE', message: expect.stringMatching(/^The invoice is in AED: an Italian invoice also keeps its total in euro at a named rate\. No exchange rate of EUR to AED/) })
    expect(rate.day?.source).toBe('ECB')
  })
})
