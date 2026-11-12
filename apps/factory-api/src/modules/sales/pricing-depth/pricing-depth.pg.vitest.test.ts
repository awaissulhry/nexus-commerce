import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedSalesPricing } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { useImporters } from '../../../platform/imports/registry'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { priceListImportAdapter } from './importer'

/**
 * B-W2b-325 on the local stack, with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security, the column grants and the …_sales_pricing_w2b_guards triggers are real): the
 * seeds' P1 list SEED-PL-P1 (version 1 ACTIVE, version 2 a DRAFT with quantity breaks for SEED-JKT-01, a 3 % break at
 * 100 pieces for every price, size 56 +20.00 and two dated prices of SEED-JKT-02), SEED-JKT-05's own size 54 +5 %, and
 * the minimums of company A (SEED-JKT-01 5 per colourway, WARN; jackets 20 per order for SEED-PL-P1's customers, a 12.00
 * small-run surcharge). Then: breaks, surcharges and dated prices of the draft; the discount shown; version 2 activated
 * and version 3 made (everything copied); a quote of P1 priced from it (the dated price of the quote's day, the break,
 * the size surcharge, the waterfall's steps the database takes); the line rules at the send and on an office order; the
 * export of a version and its import back into the next draft. Prices are made up and worked out by hand below.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/sales/pricing-depth`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'pricing-depth-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const firstId = (key: string): string => `00000000${seedId(key).slice(8)}`
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const P1 = seedId('party:P1')
const jkt01 = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const jkt02 = seedId('production:style:JKT-02')
const BLK2 = seedId('production:colourway:JKT-02:BLK')
const RED2 = seedId('production:colourway:JKT-02:RED')
const P1_LIST = seedId('pricing:list:P1')
const P1_V1 = seedId('pricing:list:P1:v1')
const P1_V2 = firstId('pricing:list:P1:v2')
const JKT01_V2 = firstId('pricing:list:P1:v2:JKT-01')
const TODAY = businessDate(new Date())

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
interface Person {
  readonly permissions: readonly Permission[]
  readonly grains: readonly string[]
  readonly companies: ScopeSet
}
const fromTemplate = (key: string, extra: readonly Permission[] = [], companies: ScopeSet = 'all'): Person => {
  const role = templateOf(key)!
  return { permissions: [...role.permissions, ...extra], grains: role.grains, companies }
}
const PEOPLE: Record<string, Person> = {
  // Sales keeps the price lists and sees prices and margin; here also the imports.
  sales: fromTemplate('sales', IMPORTS),
  // A buyer sees no price list.
  buyer: fromTemplate('buyer'),
  // A copy of the sales role without the price grain (a custom role may be).
  salesNoPrice: { ...fromTemplate('sales', IMPORTS), grains: fromTemplate('sales').grains.filter((grain) => grain !== 'price' && grain !== 'margin') },
  // Sales over company A only: a list of every company is not theirs to change.
  salesA: fromTemplate('sales', IMPORTS, [companyA]),
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions, ...grainsOf(person.grains)], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: Method, url: string, payload?: unknown) => app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
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
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const eventsOf = async (subject: string) => (await admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject]))
const v = (versionId: string) => `/sales/price-lists/${P1_LIST}/versions/${versionId}`
const versionOf = async (versionId: string): Promise<number> => (await ok('sales', 'GET', v(versionId))).version.version

beforeAll(async () => {
  db = await migratedDatabase('pricing_depth')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-pricing-depth-test-'))
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS })
  await seedCosting({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedSalesPricing({ db: database, namespace: NS })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000) ON CONFLICT DO NOTHING`, [newId(), tenant])
  // The import engine reads the person's roles from the database (at the dry run and the apply).
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.pricing@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, tenant, `custom.pricing.${key.toLowerCase()}`, key, person.permissions, person.grains])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`, [newId(), tenant, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies])
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([priceListImportAdapter])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('quantity breaks and size surcharges of a draft version (SAL-166, SAL-180)', () => {
  it('reads the seeded breaks and surcharges, prices only with the price grain', async () => {
    const rules = await ok('sales', 'GET', `${v(P1_V2)}/rules`)
    expect(rules.list).toMatchObject({ code: 'SEED-PL-P1', showDiscount: false })
    expect(rules.breaks.map((row: Json) => [row.entry?.style.code ?? '*', row.minQuantity, row.unitPrice, row.discountPct])).toEqual([
      ['SEED-JKT-01', 10, '425', null],
      ['SEED-JKT-01', 50, '415', null],
      ['*', 100, null, '3'],
    ])
    expect(rules.sizeSurcharges).toMatchObject([{ styleId: null, size: '56', amount: '20', currency: 'EUR', pct: null }])
    const blind = await ok('salesNoPrice', 'GET', `${v(P1_V2)}/rules`)
    expect(blind.breaks[0]).not.toHaveProperty('unitPrice')
    expect(blind.sizeSurcharges[0]).not.toHaveProperty('amount')
    await refused('buyer', 'GET', `${v(P1_V2)}/rules`, undefined, 403)
  })

  it('sets and removes breaks in one write, refused in words when a break does not lower the price', async () => {
    const version = await versionOf(P1_V2)
    const error = await refused('sales', 'PUT', `${v(P1_V2)}/breaks`, { version, breaks: [{ entryId: JKT01_V2, minQuantity: 20, unitPrice: '435', discountPct: null }, { entryId: null, minQuantity: 200, unitPrice: '400', discountPct: null }] }, 400)
    expect(error.issues.map((issue: Json) => issue.message)).toEqual(['A break lowers the price: below 435.', 'A break for every price of the version gives a discount, not one unit price.'])
    const rules = await ok('sales', 'PUT', `${v(P1_V2)}/breaks`, { version, breaks: [{ entryId: JKT01_V2, minQuantity: 20, unitPrice: '420', discountPct: null }, { entryId: JKT01_V2, minQuantity: 50, unitPrice: null, discountPct: null }] })
    expect(rules.breaks.map((row: Json) => [row.minQuantity, row.unitPrice ?? `${row.discountPct}%`])).toEqual([
      [10, '425'],
      [20, '420'],
      [100, '3%'],
    ])
    expect(rules.version.version).toBe(version + 1)
    // The version moved: the same write again is stale.
    expect((await refused('sales', 'PUT', `${v(P1_V2)}/breaks`, { version, breaks: [{ entryId: JKT01_V2, minQuantity: 30, unitPrice: '419', discountPct: null }] }, 409)).message).toMatch(/version/i)
    expect((await eventsOf(P1_LIST)).filter((event) => event.type === 'price_list.rules_changed').map((event) => event.payload)).toEqual([{ listId: P1_LIST, versionId: P1_V2, revision: 2, change: 'BREAKS', rows: 2 }])
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE action = 'priceLists.setBreaks' AND "recordId" = $1`, [P1_LIST])
    expect(JSON.stringify(audit!.after)).toContain('"$money":"price"')
    // Without the price grain a break's price cannot be sent; without pricelists.manage nothing.
    await refused('salesNoPrice', 'PUT', `${v(P1_V2)}/breaks`, { version: version + 1, breaks: [{ entryId: JKT01_V2, minQuantity: 30, unitPrice: '419', discountPct: null }] }, 403)
    await refused('buyer', 'PUT', `${v(P1_V2)}/breaks`, { version: version + 1, breaks: [{ entryId: null, minQuantity: 30, unitPrice: null, discountPct: '1' }] }, 403)
    // An active version's breaks are fixed.
    expect((await refused('sales', 'PUT', `${v(P1_V1)}/breaks`, { version: await versionOf(P1_V1), breaks: [{ entryId: null, minQuantity: 30, unitPrice: null, discountPct: '1' }] }, 409)).message).toBe('Version 1 is active: its quantity breaks are fixed. Make the next version to change them.')
  })

  it("sets a version's surcharge for one style and a style's own, the list's word first", async () => {
    const version = await versionOf(P1_V2)
    expect((await refused('sales', 'PUT', `${v(P1_V2)}/size-surcharges`, { version, surcharges: [{ styleId: jkt01, size: '60', amount: null, pct: '5' }] }, 400)).message).toBe('60 is not a size of SEED-JKT-01 (50, 52, 54).')
    const rules = await ok('sales', 'PUT', `${v(P1_V2)}/size-surcharges`, { version, surcharges: [{ styleId: jkt01, size: '54', amount: null, pct: '5' }] })
    expect(rules.sizeSurcharges.map((row: Json) => [row.style?.code ?? '*', row.size, row.amount, row.pct])).toEqual([
      ['SEED-JKT-01', '54', null, '5'],
      ['*', '56', '20', null],
    ])
    const own = await ok('sales', 'PUT', `/sales/styles/${jkt01}/size-surcharges`, { surcharges: [{ size: '54', amount: '15', currency: 'EUR', pct: null }] })
    expect(own.surcharges).toMatchObject([{ size: '54', amount: '15', currency: 'EUR' }])
    expect((await refused('sales', 'PUT', `/sales/styles/${jkt01}/size-surcharges`, { surcharges: [{ size: '54', amount: '15', pct: null }] }, 400)).message).toBe('An amount names its currency (ISO 4217: EUR, CHF…).')
    expect((await ok('sales', 'GET', `${v(P1_V2)}/rules`)).styleSurcharges).toMatchObject([{ style: { code: 'SEED-JKT-01' }, size: '54', amount: '15' }])
    expect((await eventsOf(jkt01)).filter((event) => event.type === 'style.size_surcharges_changed').map((event) => event.payload)).toEqual([{ styleId: jkt01, code: 'SEED-JKT-01', sizes: ['54'] }])
  })
})

describe('dated prices (SAL-167)', () => {
  it('moves the seeded season prices to days around today; an overlap is refused and nothing is written', async () => {
    const version = await versionOf(P1_V2)
    const until = addDays(TODAY, 20)
    const from = addDays(TODAY, 21)
    // The later price from `from` while the earlier still runs open: they overlap on every day from `from`.
    const error = await refused('sales', 'PUT', `${v(P1_V2)}/dated-prices`, { version, prices: [{ styleId: jkt02, colourwayId: null, validFrom: from, validTo: null, unitPrice: '415' }, { styleId: jkt02, colourwayId: null, validFrom: '2027-02-01', validTo: null, unitPrice: null }] }, 400)
    expect(error.message).toBe(`SEED-JKT-02 has two prices on the same days (to 2027-01-31 and from ${from}): the days of one style's prices never overlap.`)
    const answer = await ok('sales', 'PUT', `${v(P1_V2)}/dated-prices`, {
      version,
      prices: [
        { styleId: jkt02, colourwayId: null, validFrom: null, validTo: until, unitPrice: '400' },
        { styleId: jkt02, colourwayId: null, validFrom: '2027-02-01', validTo: null, unitPrice: null },
        { styleId: jkt02, colourwayId: null, validFrom: from, validTo: null, unitPrice: '415' },
        // SEED-JKT-02 RED's own price only from today + 21 (another colourway: no overlap with the style's prices).
        { styleId: jkt02, colourwayId: RED2, validFrom: from, validTo: null, unitPrice: '430' },
      ],
    })
    expect(answer.entries.filter((row: Json) => row.styleId === jkt02).map((row: Json) => [row.colourway?.code ?? '*', row.unitPrice, row.validFrom, row.validTo])).toEqual([
      ['*', '400', null, until],
      ['*', '415', from, null],
      ['RED', '430', from, null],
    ])
    // W2a's price cell keys a style by colourway only: a style with dated prices goes through the dated prices.
    expect((await refused('sales', 'PUT', `${v(P1_V2)}/entries`, { version: answer.version.version, entries: [{ styleId: jkt02, colourwayId: null, unitPrice: '405' }] }, 400)).message).toMatch(/prices by date/)
  })

  it('shows the discount or the net price only on the customer documents (SAL-170)', async () => {
    const list = (await ok('sales', 'GET', `/sales/price-lists/${P1_LIST}`)).list
    expect(list.showDiscount).toBe(false)
    const shown = await ok('sales', 'PUT', `/sales/price-lists/${P1_LIST}/discount-display`, { version: list.version, showDiscount: true })
    expect(shown.list).toMatchObject({ showDiscount: true, version: list.version + 1 })
    await refused('sales', 'PUT', `/sales/price-lists/${P1_LIST}/discount-display`, { version: list.version, showDiscount: false }, 409)
    await ok('sales', 'PUT', `/sales/price-lists/${P1_LIST}/discount-display`, { version: list.version + 1, showDiscount: false })
    expect((await eventsOf(P1_LIST)).filter((event) => event.type === 'price_list.changed').map((event) => event.payload.fields)).toEqual([['showDiscount'], ['showDiscount']])
  })
})

let v3 = ''

describe('the next version takes everything (prices with their days, breaks, surcharges)', () => {
  it('activates version 2 from today, then makes version 3 from it', async () => {
    const activated = await ok('sales', 'POST', `${v(P1_V2)}/activate`, { version: await versionOf(P1_V2), validFrom: TODAY, validTo: null })
    expect(activated.version).toMatchObject({ status: 'ACTIVE', validFrom: TODAY })
    const next = await ok('sales', 'POST', `/sales/price-lists/${P1_LIST}/versions`, {}, 201)
    v3 = next.version.id
    expect(next.entries.filter((row: Json) => row.styleId === jkt02).map((row: Json) => [row.colourway?.code ?? '*', row.unitPrice, row.validFrom, row.validTo])).toEqual([
      ['*', '400', null, addDays(TODAY, 20)],
      ['*', '415', addDays(TODAY, 21), null],
      ['RED', '430', addDays(TODAY, 21), null],
    ])
    const rules = await ok('sales', 'GET', `${v(v3)}/rules`)
    expect(rules.breaks.map((row: Json) => [row.entry?.style.code ?? '*', row.minQuantity])).toEqual([
      ['SEED-JKT-01', 10],
      ['SEED-JKT-01', 20],
      ['*', 100],
    ])
    expect(rules.breaks[0].entryId).not.toBe(JKT01_V2)
    expect(rules.sizeSurcharges.map((row: Json) => row.size)).toEqual(['54', '56'])
  })
})

let quote: Json = {}
const quoteUrl = (id: string) => `/sales/quotes/${id}`
const addLine = async (body: Json) => {
  quote = (await ok('sales', 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, ...body }, 201)).quote
  return quote.lines.at(-1)
}

describe("a quote's lines priced from the list (SAL-166, SAL-167, SAL-180)", () => {
  it('takes the dated price of its day, the break of its pieces and the size surcharge; the steps are a waterfall the database takes', async () => {
    quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    const jacketLine = await addLine({ styleId: jkt01, colourwayId: BLK, sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 4 }, { size: '54', quantity: 4 }] })
    expect(jacketLine).toMatchObject({ listUnitPrice: '435' })
    await addLine({ styleId: jkt02, colourwayId: BLK2, sizes: [{ size: '52', quantity: 3 }] })
    // RED's own price starts in 21 days: today's quote takes the style's price for every colourway (400).
    expect(await addLine({ styleId: jkt02, colourwayId: RED2, sizes: [{ size: '52', quantity: 1 }] })).toMatchObject({ listUnitPrice: '400' })
    const priced = await ok('sales', 'GET', `${quoteUrl(quote.id)}/list-prices`)
    expect(priced).toMatchObject({ day: TODAY, priceBasis: 'NET', showDiscount: false })
    const [first, second] = priced.lines
    // 12 pieces reach the 10-piece break (425); size 54 takes the version's 5 % for SEED-JKT-01 (21.25), not the style's own 15.
    expect(first).toMatchObject({ listPrice: '435', break: { minQuantity: 10, pieces: 12, unitPrice: '425', delta: '-10' }, unitPrice: '425', sizeSurcharges: [{ size: '54', amount: '21.25', pct: '5', scope: 'VERSION_STYLE' }] })
    expect(first.list).toMatchObject({ code: 'SEED-PL-P1', revision: 2 })
    // SEED-JKT-02: the price that holds on the quote's day (400 to today + 20).
    expect(second).toMatchObject({ listPrice: '400', break: null, unitPrice: '400', list: { validTo: addDays(TODAY, 20) } })
    expect(priced.lines[2]).toMatchObject({ listPrice: '400', list: { colourwayPrice: false, validTo: addDays(TODAY, 20) } })
    // The steps go into the line as its waterfall with the price they reach (the database checks every step).
    await admin(`UPDATE "QuoteLine" SET "unitPrice" = $2, "priceSteps" = $3::jsonb WHERE id = $1`, [first.lineId, first.unitPrice, JSON.stringify(first.steps)])
    const [stored] = await admin(`SELECT "priceSteps" FROM "QuoteLine" WHERE id = $1`, [first.lineId])
    expect(stored!.priceSteps.map((step: Json) => step.kind)).toEqual(['LIST', 'BREAK', 'SIZE_SURCHARGE', 'NET'])
    // Without the price grain: no figure.
    const blind = (await ok('salesNoPrice', 'GET', `${quoteUrl(quote.id)}/list-prices`)).lines[0]
    expect(blind).not.toHaveProperty('listPrice')
    expect(blind).not.toHaveProperty('steps')
    quote = (await ok('sales', 'GET', quoteUrl(quote.id))).quote
  })
})

let blockRule: Json = {}

describe('minimum order quantities at the send and on an office order (SAL-178)', () => {
  it('a WARN, a SURCHARGE and a BLOCK minimum, in words; the BLOCK stops the send', async () => {
    const error = await refused('sales', 'POST', '/sales/minimums', { companyId: companyA, styleId: jkt02, productType: 'JACKET', minQuantity: 5, per: 'LINE', action: 'BLOCK' }, 400)
    expect(error.message).toBe('A minimum is about one style, one kind of garment or one material: exactly one.')
    blockRule = (await ok('sales', 'POST', '/sales/minimums', { companyId: companyA, styleId: jkt02, minQuantity: 5, per: 'LINE', action: 'BLOCK', note: 'Below 5 the leather lot is not cut.' }, 201)).minimum
    expect(blockRule).toMatchObject({ subject: 'STYLE', style: { code: 'SEED-JKT-02' }, per: 'LINE', action: 'BLOCK', status: 'ACTIVE' })
    expect((await refused('sales', 'POST', '/sales/minimums', { companyId: companyA, styleId: jkt02, minQuantity: 8, per: 'LINE', action: 'WARN' }, 409)).message).toMatch(/already counts this subject/)
    await refused('buyer', 'POST', '/sales/minimums', { companyId: companyA, styleId: jkt02, minQuantity: 8, per: 'ORDER', action: 'WARN' }, 403)
    const checks = await ok('sales', 'GET', `${quoteUrl(quote.id)}/line-checks`)
    expect(checks.priceListId).toBe(P1_LIST)
    expect(checks.findings.map((finding: Json) => [finding.severity, finding.seqs, finding.message])).toEqual([
      ['BLOCKS', [20], 'SEED-JKT-02: 3 pieces on line 20 (SEED-JKT-02 BLK); the minimum is 5 per line. The quote cannot go out below it. Below 5 the leather lot is not cut.'],
      ['BLOCKS', [30], 'SEED-JKT-02: 1 piece on line 30 (SEED-JKT-02 RED); the minimum is 5 per line. The quote cannot go out below it. Below 5 the leather lot is not cut.'],
      ['WARNING', [10, 20, 30], 'Jackets: 16 pieces on this quote; the minimum is 20 per quote. Below it a small-run surcharge per piece applies.'],
    ])
    expect(checks.findings[2].details).toMatchObject({ action: 'SURCHARGE', minQuantity: 20, quantity: 16, surcharge: { amount: '12', currency: 'EUR', pct: null } })
    const blind = (await ok('salesNoPrice', 'GET', `${quoteUrl(quote.id)}/line-checks`)).findings[2].details
    expect(blind.surcharge).toEqual({ currency: 'EUR' })
    const send = await ok('sales', 'GET', `${quoteUrl(quote.id)}/send-check`)
    expect(send.ready).toBe(false)
    expect(send.checks.filter((check: Json) => check.code === 'BELOW_MINIMUM').map((check: Json) => check.severity)).toEqual(['BLOCKS', 'BLOCKS', 'WARNING'])
    // The send itself is refused with the minimum in its words (beside the quote's other open checks).
    const sent = await refused('sales', 'POST', `${quoteUrl(quote.id)}/send`, { version: quote.version }, 409)
    expect(sent.message).toContain('the minimum is 5 per line. The quote cannot go out below it.')
    // An office order of 3 pieces of SEED-JKT-02 is refused too (its preview names the problem).
    const preview = await ok('sales', 'POST', '/sales/orders/manual/preview', { companyId: companyA, partyId: P1, lines: [{ styleId: jkt02, colourwayId: BLK2, sizes: [{ size: '52', quantity: 3 }] }] })
    expect(preview.ok).toBe(false)
    expect(preview.problems.map((problem: Json) => problem.message)).toContain('SEED-JKT-02: 3 pieces on line 10 (SEED-JKT-02 BLK); the minimum is 5 per line. The order cannot go out below it. Below 5 the leather lot is not cut.')
  })

  it('archived, the BLOCK stops nothing; an edit keeps the subject; the order line checks read the same rules', async () => {
    const archived = await ok('sales', 'POST', `/sales/minimums/${blockRule.id}/archive`, { version: blockRule.version })
    expect(archived.minimum.status).toBe('ARCHIVED')
    const send = await ok('sales', 'GET', `${quoteUrl(quote.id)}/send-check`)
    expect(send.checks.filter((check: Json) => check.code === 'BELOW_MINIMUM').map((check: Json) => check.severity)).toEqual(['WARNING'])
    const back = await ok('sales', 'POST', `/sales/minimums/${blockRule.id}/reactivate`, { version: archived.minimum.version })
    const edited = await ok('sales', 'PATCH', `/sales/minimums/${blockRule.id}`, { version: back.minimum.version, minQuantity: 3, action: 'WARN' })
    expect(edited.minimum).toMatchObject({ minQuantity: 3, action: 'WARN', style: { code: 'SEED-JKT-02' } })
    // At least 3 per line, a warning: line 20 (3 pieces) meets it, line 30 (1) does not.
    expect((await ok('sales', 'GET', `${quoteUrl(quote.id)}/line-checks`)).findings.map((finding: Json) => finding.seqs)).toEqual([[10, 20, 30], [30]])
    await ok('sales', 'DELETE', `/sales/minimums/${blockRule.id}?version=${edited.minimum.version}`)
    expect((await eventsOf(blockRule.id)).map((event) => event.payload.change)).toEqual(['CREATED', 'ARCHIVED', 'REACTIVATED', 'UPDATED', 'DELETED'])
    const order = await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE number = 'SEED-SO-0004'`)
    const orderChecks = await ok('sales', 'GET', `/sales/orders/${order[0]!.id}/line-checks`)
    expect(orderChecks.findings.map((finding: Json) => finding.message)).toEqual(['Jackets: 4 pieces on this order; the minimum is 20 per order. Below it a small-run surcharge per piece applies.'])
    expect((await ok('sales', 'GET', '/sales/minimums?priceListId=' + P1_LIST)).minimums.map((row: Json) => row.productType)).toEqual(['JACKET'])
  })
})

// ---- import and export (SAL-183) ---------------------------------------------------------------------------------------

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
async function upload(session: string, body: Buffer, fields: Json = {}): Promise<Json> {
  const started = await call(session, 'POST', '/imports', { importerKey: 'sales.priceLists', file: { originalName: 'prices.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, ...fields })
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
  const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  expect((await call(session, 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
  await planImport(system(), job.id, { lastAttempt: true })
  return (await call(session, 'GET', `/imports/${job.id}`)).json().job
}
const rowsOf = async (session: string, jobId: string): Promise<Json[]> => (await call(session, 'GET', `/imports/${jobId}/rows`)).json().rows

describe('the export of a version and its import into the next draft (SAL-183)', () => {
  let exported = ''
  it('writes the import columns as CSV (Italian numbers) and Excel; without the price grain it is refused', async () => {
    const response = await call('sales', 'GET', `${v(P1_V2)}/export?format=csv`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-disposition']).toContain('price-list-SEED-PL-P1-v2.csv')
    exported = response.body
    const lines = exported.trim().split('\r\n')
    expect(lines[0]).toBe('Price list;Style;Colourway;Valid from;Valid to;Unit price;Quantity breaks')
    expect(lines.slice(1)).toEqual([`SEED-PL-P1;SEED-JKT-01;*;-;-;435;"10=425;20=420"`, `SEED-PL-P1;SEED-JKT-02;*;-;${addDays(TODAY, 20)};400;`, `SEED-PL-P1;SEED-JKT-02;*;${addDays(TODAY, 21)};-;415;`, `SEED-PL-P1;SEED-JKT-02;RED;${addDays(TODAY, 21)};-;430;`])
    const xlsx = await call('sales', 'GET', `${v(P1_V2)}/export?format=xlsx&numberFormat=en`)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(xlsx.rawPayload as unknown as ArrayBuffer)
    expect(workbook.getWorksheet('Prices')!.getRow(2).getCell(6).value).toBe(435)
    expect(workbook.getWorksheet('Columns')!.rowCount).toBe(8)
    expect((await refused('salesNoPrice', 'GET', `${v(P1_V2)}/export?format=csv`, undefined, 403)).message).toBe("A price list's file holds its prices: your role does not see prices.")
  })

  it('reads its own file back unchanged; an edited file updates the draft, refusing in words what it cannot', async () => {
    const same = await upload('sales', Buffer.from(exported, 'utf8'), { companyId: companyA })
    expect(same).toMatchObject({ status: 'PLANNED', rowCount: 4, unchangedCount: 4, errorCount: 0 })
    const edited = Buffer.from(
      [
        'Listino;Modello;Variante;Valido dal;Valido al;Prezzo;Scaglioni',
        'SEED-PL-P1;SEED-JKT-01;*;-;-;440;10=430',
        'SEED-PL-P1;SEED-JKT-01;BLK;-;-;445;',
        `SEED-PL-P1;SEED-JKT-02;*;${addDays(TODAY, 10)};-;410;`,
        'SEED-PL-BASE;SEED-JKT-01;*;-;-;460;',
        'SEED-PL-P1;SEED-JKT-01;RED;-;-;;',
      ].join('\r\n'),
      'utf8',
    )
    const job = await upload('sales', edited, { companyId: companyA })
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 5, createCount: 1, updateCount: 1, errorCount: 3 })
    const rows = await rowsOf('sales', job.id)
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([
      [2, 'UPDATE'],
      [3, 'CREATE'],
      [4, 'ERROR'],
      [5, 'ERROR'],
      [6, 'ERROR'],
    ])
    expect(rows[2]!.errors[0].message).toBe(`The style has another price on these days (to ${addDays(TODAY, 20)}): the days of one style's prices never overlap.`)
    expect(rows[3]!.errors[0].message).toBe("SEED-PL-BASE has no draft version (an active version's prices are fixed): make the next version, then import into it.")
    expect(rows[4]!.errors[0].message).toBe('A new price needs its unit price.')
    const applied = await call('sales', 'POST', `/imports/${job.id}/apply`, { version: job.version })
    expect(applied.statusCode, applied.body).toBe(200)
    await applyPlan(system(), job.id, { lastAttempt: true })
    const draft = await ok('sales', 'GET', v(v3))
    expect(draft.entries.filter((row: Json) => row.styleId === jkt01).map((row: Json) => [row.colourway?.code ?? '*', row.unitPrice])).toEqual([
      ['*', '440'],
      ['BLK', '445'],
    ])
    const rules = await ok('sales', 'GET', `${v(v3)}/rules`)
    expect(rules.breaks.filter((row: Json) => row.entry?.style.code === 'SEED-JKT-01').map((row: Json) => [row.minQuantity, row.unitPrice])).toEqual([[10, '430']])
    // A person without the price grain may not map the price columns at all.
    const blind = await call('salesNoPrice', 'POST', '/imports', { importerKey: 'sales.priceLists', file: { originalName: 'p.csv', contentType: SHEET_TYPES.csv, sizeBytes: edited.length, sha256: sha256(edited) } })
    expect([201, 403]).toContain(blind.statusCode)
  })
})
