import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * B-W2a-19 on the local stack, with the app's real routes (a throwaway PostgreSQL 17 database from the migrations, the
 * runtime login: row-level security, the column grants and the …_sales_w2a_guards triggers are real): the payment terms
 * library (FIN-075), the customer's commercial terms (SAL-012) and the price lists (SAL-165) with their versions, and a
 * quote that takes the customer's terms and reads its list prices. The seeds' brand customer P1 (an Italian business,
 * every company), the private rider P4 (a consumer), the jacket SEED-JKT-01 in BLK and RED (sizes 50 / 52 / 54, base size
 * 52: 290.439 a piece from the costing seed's sheet, no overhead). Prices are made up and worked out by hand below.
 * Run with `node scripts/factory/run-pg-tests.mjs pricelists`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'pricelists-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const P1 = seedId('party:P1')
const P2 = seedId('party:P2')
const P4 = seedId('party:P4')
const jacket = seedId('product:style:JKT-01')
const BLK = seedId('product:colourway:JKT-01:BLK')
const RED = seedId('product:colourway:JKT-01:RED')
const TODAY = businessDate(new Date())
const YESTERDAY = addDays(TODAY, -1)
const YEAR = TODAY.slice(0, 4)

const grainsOf = (grains: readonly string[]): Permission[] => grains.map((grain) => `money.${grain}` as Permission)
interface Person {
  readonly actorId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const fromTemplate = (key: string, companies: ScopeSet = 'all'): Person => {
  const role = templateOf(key)!
  return { actorId: newId(), permissions: [...role.permissions, ...grainsOf(role.grains)], companies }
}
const PEOPLE: Record<string, Person> = {
  // Sales keeps the price lists and the customers' terms and picks from the terms library; it sees prices and margin %.
  sales: fromTemplate('sales'),
  // Finance keeps the terms library and sees every grain.
  finance: fromTemplate('finance'),
  // A buyer may edit parties but keeps no price list and sees no price.
  buyer: fromTemplate('buyer'),
  readOnly: fromTemplate('read_only'),
  // Sales over company B only.
  salesB: fromTemplate('sales', [companyB]),
  // A copy of the sales role without the price grain (a custom role may be).
  salesNoPrice: { ...fromTemplate('sales'), permissions: fromTemplate('sales').permissions.filter((name) => name !== 'money.price' && name !== 'money.margin') },
}
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: person.actorId, grants: [grant] }]
  }),
)
SESSIONS.partner = { audience: 'partner', tenantId: tenant, actorId: newId(), partyId: P1, grants: [{ permissions: ['parties.view', 'pricelists.view', 'paymentterms.view', 'money.price'], companies: 'all', sites: 'all', parties: [P1] }] }

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
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((event) => event.type)
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

beforeAll(async () => {
  db = await migratedDatabase('pricelists')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedCompliance({ db: database, namespace: NS }) // the product and parties seeds come with it
  await seedCosting({ db: database, namespace: NS })
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'QUOTE', 'MAIN', $4, 'YEARLY', 'Q-{YYYY}-{N:4}', false)`, [newId(), tenant, companyA, YEAR])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const DEP10 = {
  code: 'dep10',
  name: "30% all'ordine, saldo prima della spedizione",
  nameI18n: { en: '30% with the order, the balance before shipping' },
  method: 'MP05',
  instalments: [
    { sharePct: '30', from: 'ORDER', days: 10 },
    { sharePct: '70', from: 'BEFORE_SHIPPING', days: 0 },
  ],
}
const terms = {} as { DEP10: Json; BB30FM: Json }
const lists = {} as { BASE: Json; P1: Json; GROUP: Json }

describe('the payment terms library (FIN-075)', () => {
  it('finance adds terms: code in capitals, the rules in words, the deposit they ask', async () => {
    terms.DEP10 = (await ok('finance', 'POST', '/sales/payment-terms', DEP10, 201)).terms
    expect(terms.DEP10).toMatchObject({
      companyId: null,
      code: 'DEP10',
      method: 'MP05',
      instalments: [
        { sharePct: '30', from: 'ORDER', days: 10, endOfMonth: false },
        { sharePct: '70', from: 'BEFORE_SHIPPING', days: 0, endOfMonth: false },
      ],
      deposit: { sharePct: '30', days: 10 },
      summary: { it: "Bonifico bancario: 30% entro 10 gg dall'ordine · 70% prima della spedizione", en: 'Bank transfer: 30% within 10 days of the order · 70% before shipping' },
      status: 'ACTIVE',
      customers: 0,
      version: 1,
    })
    terms.BB30FM = (await ok('finance', 'POST', '/sales/payment-terms', { companyId: companyA, code: 'BB30FM', name: 'Bonifico 30 gg d.f.f.m.', method: 'MP05', instalments: [{ sharePct: '100', from: 'INVOICE', days: 30, endOfMonth: true }], earlyPaymentDiscountPct: '2', earlyPaymentDays: 10 }, 201)).terms
    expect(terms.BB30FM).toMatchObject({ companyId: companyA, earlyPaymentDiscountPct: '2', earlyPaymentDays: 10, deposit: null, summary: { it: 'Bonifico bancario: 100% a 30 gg data fattura fine mese · sconto 2% entro 10 gg' } })
    expect(await eventsOf(terms.DEP10.id)).toEqual(['payment_terms.changed'])
    const audit = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1`, [terms.DEP10.id])
    expect(audit).toMatchObject([{ action: 'paymentTerms.create', after: { code: 'DEP10', status: 'ACTIVE' } }])
  })

  it('refuses a taken code, shares that do not total 100, and a person who may not keep the library', async () => {
    expect((await refused('finance', 'POST', '/sales/payment-terms', DEP10, 409)).message).toBe('The payment terms code DEP10 is taken.')
    const wrong = await refused('finance', 'POST', '/sales/payment-terms', { ...DEP10, code: 'X1', instalments: [{ sharePct: '30', from: 'ORDER', days: 0 }, { sharePct: '60', from: 'INVOICE', days: 30 }] }, 400)
    expect(wrong.issues).toEqual([{ path: 'body/instalments', message: 'The shares total 90%: they must total 100%.' }])
    await refused('sales', 'POST', '/sales/payment-terms', { ...DEP10, code: 'X2' }, 403)
    // Terms of every company are kept only by a grant over every company.
    await refused('salesB', 'GET', `/sales/payment-terms/${terms.BB30FM.id}`, undefined, 404)
  })

  it('is read by sales (to pick from it), by code; never by a partner session', async () => {
    const listed = await ok('sales', 'GET', '/sales/payment-terms')
    expect(listed.terms.map((row: Json) => row.code)).toEqual(['BB30FM', 'DEP10'])
    expect((await ok('salesB', 'GET', '/sales/payment-terms')).terms.map((row: Json) => row.code)).toEqual(['DEP10'])
    await refused('partner', 'GET', '/sales/payment-terms', undefined, 403)
  })
})

describe('price lists (SAL-165): a base list, a customer list over it, dated versions', () => {
  it('sales makes the base list with its first draft version, prices it and activates it', async () => {
    lists.BASE = (await ok('sales', 'POST', '/sales/price-lists', { companyId: companyA, code: 'pl-base', name: 'Listino base', kind: 'BASE', validFrom: TODAY }, 201)).list
    expect(lists.BASE).toMatchObject({ code: 'PL-BASE', kind: 'BASE', currency: 'EUR', state: 'DRAFT', baseList: null, customers: [], versions: [{ revision: 1, status: 'DRAFT', validFrom: TODAY, validTo: null, entries: 0 }] })
    const v1 = lists.BASE.versions[0]
    const priced = await ok('sales', 'PUT', `/sales/price-lists/${lists.BASE.id}/versions/${v1.id}/entries`, { version: v1.version, entries: [{ styleId: jacket, colourwayId: null, unitPrice: '450' }] })
    // Sales sees the margin % at today's standard cost (290.439 at size 52), never the cost (design question S2, answer a).
    expect(priced.entries).toEqual([{ id: expect.any(String), styleId: jacket, style: { code: 'SEED-JKT-01', name: 'Seed leather jacket', status: expect.any(String) }, colourwayId: null, colourway: null, unitPrice: '450', marginPct: '35.458', belowFloor: false, version: 1 }])
    const read = await ok('finance', 'GET', `/sales/price-lists/${lists.BASE.id}/versions/${v1.id}`)
    expect(read.entries[0]).toMatchObject({ unitPrice: '450', standardCost: '290.439', marginPct: '35.458' })
    // Price lists are not the buyer's; a copy of the sales role without the price grain reads no price.
    await refused('buyer', 'GET', `/sales/price-lists/${lists.BASE.id}/versions/${v1.id}`, undefined, 403)
    expect(keysOf((await ok('salesNoPrice', 'GET', `/sales/price-lists/${lists.BASE.id}/versions/${v1.id}`)).entries)).not.toContain('unitPrice')
    const activated = await ok('sales', 'POST', `/sales/price-lists/${lists.BASE.id}/versions/${v1.id}/activate`, { version: priced.version.version })
    expect(activated).toMatchObject({ version: { revision: 1, status: 'ACTIVE', validFrom: TODAY, validTo: null, activatedById: PEOPLE.sales!.actorId }, ended: null })
    // Its prices are fixed now.
    expect((await refused('sales', 'PUT', `/sales/price-lists/${lists.BASE.id}/versions/${v1.id}/entries`, { version: activated.version.version, entries: [{ styleId: jacket, colourwayId: null, unitPrice: '460' }] }, 409)).code).toBe('invalid_state')
    expect(await eventsOf(lists.BASE.id)).toEqual(['price_list.changed', 'price_list.version_changed', 'price_list.version_changed', 'price_list.version_activated'])
  })

  it('keeps one base list per company and currency, and refuses what cannot go live', async () => {
    expect((await refused('sales', 'POST', '/sales/price-lists', { companyId: companyA, code: 'PL-BASE-2', name: 'Again', kind: 'BASE' }, 409)).message).toMatch(/PL-BASE is the base list of this company in EUR already/)
    const group = (await ok('sales', 'POST', '/sales/price-lists', { companyId: companyA, code: 'PL-GRP', name: 'Gruppo rivenditori', kind: 'GROUP' }, 201)).list
    const draft = group.versions[0]
    expect((await refused('sales', 'POST', `/sales/price-lists/${group.id}/versions/${draft.id}/activate`, { version: draft.version }, 409)).message).toBe('Version 1 has no prices yet: add styles before activating it.')
    const priced = await ok('sales', 'PUT', `/sales/price-lists/${group.id}/versions/${draft.id}/entries`, { version: draft.version, entries: [{ styleId: jacket, colourwayId: BLK, unitPrice: '400' }] })
    const past = await refused('sales', 'POST', `/sales/price-lists/${group.id}/versions/${draft.id}/activate`, { version: priced.version.version, validFrom: YESTERDAY }, 400)
    expect(past.issues).toEqual([{ path: 'body/validFrom', message: `A version is activated from today (${TODAY}) or a later day, never back in time: quotes already priced keep their version.` }])
    // A row without its price is refused, never taken as a removal; a stale version is a conflict.
    await refused('sales', 'PUT', `/sales/price-lists/${group.id}/versions/${draft.id}/entries`, { version: priced.version.version, entries: [{ styleId: jacket, colourwayId: BLK }] }, 400)
    await refused('sales', 'PUT', `/sales/price-lists/${group.id}/versions/${draft.id}/entries`, { version: 1, entries: [{ styleId: jacket, colourwayId: BLK, unitPrice: '1' }] }, 409)
    lists.GROUP = group
  })

  it("makes the customer's list over the base list, priced only in red", async () => {
    lists.P1 = (await ok('sales', 'POST', '/sales/price-lists', { companyId: companyA, code: 'PL-P1', name: 'Listino Cliente Uno', kind: 'CUSTOMER', baseListId: lists.BASE.id }, 201)).list
    const v1 = lists.P1.versions[0]
    await ok('sales', 'PUT', `/sales/price-lists/${lists.P1.id}/versions/${v1.id}/entries`, { version: v1.version, entries: [{ styleId: jacket, colourwayId: RED, unitPrice: '430' }] })
    // Active since the start of the year (written as the database would after an activation then; the API activates
    // from today on), so the next version can start today and end this one yesterday.
    await admin(`UPDATE "PriceListVersion" SET status = 'ACTIVE', "validFrom" = $2, "activatedAt" = now(), "activatedById" = $3, version = version + 1 WHERE id = $1`, [v1.id, `${YEAR}-01-01`, PEOPLE.sales!.actorId])
    lists.P1 = (await ok('sales', 'GET', `/sales/price-lists/${lists.P1.id}`)).list
    expect(lists.P1).toMatchObject({ state: 'IN_FORCE', baseList: { id: lists.BASE.id, code: 'PL-BASE' }, shownVersion: { revision: 1, status: 'ACTIVE' }, stylesPriced: 1 })
    expect((await ok('sales', 'GET', `/sales/price-lists/${lists.BASE.id}`)).list.fallbackOf).toEqual([{ id: lists.P1.id, code: 'PL-P1', name: 'Listino Cliente Uno', kind: 'CUSTOMER', status: 'ACTIVE' }])
    const page = await ok('readOnly', 'GET', '/sales/price-lists')
    expect(page.lists.map((row: Json) => [row.code, row.state])).toEqual([['PL-BASE', 'IN_FORCE'], ['PL-GRP', 'DRAFT'], ['PL-P1', 'IN_FORCE']])
    expect(page.tiles).toEqual({ inForce: 2, startingIn30Days: 0, endingIn30Days: 0 })
    expect((await ok('sales', 'GET', '/sales/price-lists?state=DRAFT')).lists.map((row: Json) => row.code)).toEqual(['PL-GRP'])
    // A list never falls back to one that falls back to it.
    const base = (await ok('sales', 'GET', `/sales/price-lists/${lists.BASE.id}`)).list
    expect((await refused('sales', 'PATCH', `/sales/price-lists/${lists.BASE.id}`, { version: base.version, baseListId: lists.P1.id }, 400)).message).toBe('PL-P1 falls back to this list already: no circle.')
  })
})

describe("the customer's commercial terms (SAL-012)", () => {
  it('sales gives P1 its terms, list, invoicing, Incoterms and minimum order in one change', async () => {
    const before = (await ok('sales', 'GET', `/parties/${P1}/commercial-terms`)).terms
    expect(before).toMatchObject({ paymentTermsId: null, priceListId: null, invoiceTiming: 'PER_SHIPMENT', invoiceTypePreset: 'TD01', priceChain: [] })
    const after = (await ok('sales', 'PATCH', `/parties/${P1}/commercial-terms`, { version: before.version, paymentTermsId: terms.DEP10.id, priceListId: lists.P1.id, invoiceTiming: 'MONTHLY', incoterm: 'DAP', preferredCarrierCode: 'brt', minimumOrderAmount: 100_000 })).terms
    expect(after).toMatchObject({
      paymentTermsId: terms.DEP10.id,
      paymentTerms: { code: 'DEP10', deposit: { sharePct: '30', days: 10 } },
      priceListId: lists.P1.id,
      priceList: { code: 'PL-P1', kind: 'CUSTOMER' },
      priceChain: [{ code: 'PL-P1' }, { code: 'PL-BASE' }],
      discountGroup: null,
      defaultDepositPct: null,
      invoiceTiming: 'MONTHLY',
      invoiceTypePreset: 'TD24',
      incoterm: 'DAP',
      preferredCarrierCode: 'brt',
      minimumOrderAmount: 100_000,
      version: before.version + 1,
    })
    expect(await eventsOf(P1)).toContain('party.updated')
    const [audit] = await admin(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'parties.setCommercialTerms'`, [P1])
    expect(audit).toMatchObject({ after: { paymentTermsId: terms.DEP10.id, listId: lists.P1.id, invoiceTiming: 'MONTHLY', incoterm: 'DAP' } })
    // The library and the lists count their customers now.
    expect((await ok('finance', 'GET', `/sales/payment-terms/${terms.DEP10.id}`)).terms.customers).toBe(1)
    expect((await ok('sales', 'GET', `/sales/price-lists/${lists.P1.id}`)).list.customers).toMatchObject([{ id: P1, code: 'SEED-C1' }])
  })

  it('refuses what a buyer may not give or see, a list in another currency, a supplier, archived terms', async () => {
    const current = (await ok('sales', 'GET', `/parties/${P1}/commercial-terms`)).terms
    const notHis = await refused('buyer', 'PATCH', `/parties/${P1}/commercial-terms`, { version: current.version, priceListId: lists.BASE.id }, 400)
    expect(notHis.issues).toEqual([{ path: 'body/priceListId', message: 'Not a price list you may see.' }])
    // The minimum order is a price: a buyer can neither send nor see it.
    await refused('buyer', 'PATCH', `/parties/${P1}/commercial-terms`, { version: current.version, minimumOrderAmount: 1 }, 403)
    expect(keysOf((await ok('buyer', 'GET', `/parties/${P1}/commercial-terms`)).terms)).not.toContain('minimumOrderAmount')
    const usd = (await ok('sales', 'POST', '/sales/price-lists', { companyId: companyA, code: 'PL-USD', name: 'Export', kind: 'CONTRACT', currency: 'USD' }, 201)).list
    expect((await refused('sales', 'PATCH', `/parties/${P1}/commercial-terms`, { version: current.version, priceListId: usd.id }, 400)).message).toBe("PL-USD is in USD; SEED-C1's documents are in EUR.")
    const supplier = (await ok('sales', 'GET', `/parties/${P2}/commercial-terms`)).terms
    expect((await refused('sales', 'PATCH', `/parties/${P2}/commercial-terms`, { version: supplier.version, incoterm: 'EXW' }, 409)).message).toMatch(/is not a customer: commercial terms are a customer's/)
    await refused('sales', 'PATCH', `/parties/${P1}/commercial-terms`, { version: current.version, incoterm: 'XXX' }, 400)
    await refused('partner', 'GET', `/parties/${P1}/commercial-terms`, undefined, 403)
  })

  it('keeps what customers use: terms and lists are not archived under them', async () => {
    expect((await refused('finance', 'POST', `/sales/payment-terms/${terms.DEP10.id}/archive`, { version: terms.DEP10.version }, 409)).message).toBe('1 customer has DEP10 as its default payment terms: give it other terms first.')
    const p1 = (await ok('sales', 'GET', `/sales/price-lists/${lists.P1.id}`)).list
    expect((await refused('sales', 'POST', `/sales/price-lists/${lists.P1.id}/archive`, { version: p1.version }, 409)).message).toBe('1 customer is priced from PL-P1: give it another list first.')
    const base = (await ok('sales', 'GET', `/sales/price-lists/${lists.BASE.id}`)).list
    expect((await refused('sales', 'POST', `/sales/price-lists/${lists.BASE.id}/archive`, { version: base.version }, 409)).message).toBe('PL-P1 falls back to PL-BASE: change it first.')
    // Archived terms are never given: BB30FM archived, then refused for a customer.
    const archived = (await ok('finance', 'POST', `/sales/payment-terms/${terms.BB30FM.id}/archive`, { version: terms.BB30FM.version })).terms
    expect(archived.status).toBe('ARCHIVED')
    const current = (await ok('sales', 'GET', `/parties/${P4}/commercial-terms`)).terms
    expect((await refused('sales', 'PATCH', `/parties/${P4}/commercial-terms`, { version: current.version, paymentTermsId: terms.BB30FM.id }, 400)).message).toBe('BB30FM is archived: give the customer active terms.')
    terms.BB30FM = (await ok('finance', 'POST', `/sales/payment-terms/${terms.BB30FM.id}/reactivate`, { version: archived.version })).terms
  })
})

let quote: Json
const quoteUrl = (id: string) => `/sales/quotes/${id}`
const addLine = async (session: string, body: Json) => {
  quote = (await ok(session, 'POST', `${quoteUrl(quote.id)}/lines`, { version: quote.version, ...body }, 201)).quote
  return quote.lines.at(-1)
}
const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))

describe("a quote takes the customer's terms and reads its list prices", () => {
  it("is made with P1's terms (printed in its language), the deposit they ask and its list version", async () => {
    quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    const p1v1 = lists.P1.versions[0]
    expect(quote.current).toMatchObject({
      paymentTermsId: terms.DEP10.id,
      paymentTerms: "30% all'ordine, saldo prima della spedizione",
      depositPct: '30',
      depositKind: 'ACCONTO',
      priceList: { listId: lists.P1.id, code: 'PL-P1', versionId: p1v1.id, revision: 1 },
      // Nothing quoted yet: 1,000.00 short of P1's minimum order.
      belowMinimum: { minimum: 100_000, short: 100_000 },
    })
    const english = (await ok('sales', 'PATCH', quoteUrl(quote.id), { version: quote.version, language: 'en' })).quote
    expect(english.current).toMatchObject({ language: 'en', paymentTerms: '30% with the order, the balance before shipping' })
    quote = (await ok('sales', 'PATCH', quoteUrl(quote.id), { version: english.version, language: 'it' })).quote
  })

  it("prices a line from the list: the colourway's own price, else the style's in the list it falls back to", async () => {
    const red = await addLine('sales', { styleId: jacket, colourwayId: RED, sizes: grid([['50', 1], ['52', 3], ['54', 2]]) })
    expect(red).toMatchObject({ listUnitPrice: '430', unitPrice: '430', netAmount: 6 * 43_000 })
    const black = await addLine('sales', { styleId: jacket, colourwayId: BLK, sizes: grid([['52', 2]]) })
    expect(black).toMatchObject({ listUnitPrice: '450', unitPrice: '450', netAmount: 90_000 })
    const discounted = await addLine('sales', { styleId: jacket, colourwayId: BLK, sizes: grid([['54', 1]]), discountPct: '10' })
    expect(discounted).toMatchObject({ listUnitPrice: '450', unitPrice: '405', discountPct: '10' })
    // A hand price keeps the list price beside it (the discount rule reads it).
    const byHand = await addLine('sales', { styleId: jacket, colourwayId: RED, sizes: grid([['50', 1]]), unitPrice: '400' })
    expect(byHand).toMatchObject({ listUnitPrice: '430', unitPrice: '400' })
    expect(quote.current.belowMinimum).toBeNull()
    // A line at its list price that changes colour moves to the new colour's list price.
    const moved = (await ok('sales', 'PATCH', `${quoteUrl(quote.id)}/lines/${red.id}`, { version: quote.version, colourwayId: BLK })).quote
    quote = moved
    expect(moved.lines.find((line: Json) => line.id === red.id)).toMatchObject({ listUnitPrice: '450', unitPrice: '450' })
  })

  it('keeps its list version when the next one goes live; a new quote takes the new one', async () => {
    const draft = (await ok('sales', 'POST', `/sales/price-lists/${lists.P1.id}/versions`, { note: 'Next season' }, 201)).version
    expect(draft).toMatchObject({ revision: 2, status: 'DRAFT', entries: 1 })
    const raised = await ok('sales', 'PUT', `/sales/price-lists/${lists.P1.id}/versions/${draft.id}/entries`, { version: draft.version, entries: [{ styleId: jacket, colourwayId: RED, unitPrice: '445' }, { styleId: jacket, colourwayId: null, unitPrice: '440' }] })
    const compared = await ok('sales', 'GET', `/sales/price-lists/${lists.P1.id}/versions/${draft.id}/compare?with=${lists.P1.versions[0].id}`)
    expect(compared).toMatchObject({ changed: 2, rows: [{ colourwayId: null, before: null, after: '440', change: 'ADDED' }, { colourwayId: RED, before: '430', after: '445', change: 'CHANGED', changePct: '3.49' }] })
    // One draft at a time.
    expect((await refused('sales', 'POST', `/sales/price-lists/${lists.P1.id}/versions`, {}, 409)).message).toBe('Version 2 is a draft already: edit its prices, or delete it first.')
    const live = await ok('sales', 'POST', `/sales/price-lists/${lists.P1.id}/versions/${draft.id}/activate`, { version: raised.version.version, validFrom: TODAY })
    expect(live).toMatchObject({ version: { revision: 2, status: 'ACTIVE', validFrom: TODAY, validTo: null }, ended: { revision: 1, validTo: YESTERDAY } })
    const record = (await ok('sales', 'GET', `/sales/price-lists/${lists.P1.id}`)).list
    expect(record.versions.map((version: Json) => [version.revision, version.status, version.validFrom, version.validTo])).toEqual([[2, 'ACTIVE', TODAY, null], [1, 'ACTIVE', `${YEAR}-01-01`, YESTERDAY]])
    // An active version's start is fixed; its end never reaches into the next version.
    await refused('sales', 'PATCH', `/sales/price-lists/${lists.P1.id}/versions/${record.versions[1].id}`, { version: record.versions[1].version, validFrom: `${YEAR}-02-01` }, 409)
    // The open quote keeps version 1: red at 430.
    const kept = await addLine('sales', { styleId: jacket, colourwayId: RED, sizes: grid([['52', 1]]) })
    expect(kept).toMatchObject({ listUnitPrice: '430' })
    expect(quote.current.priceList).toMatchObject({ revision: 1 })
    const fresh = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 }, 201)).quote
    expect(fresh.current.priceList).toMatchObject({ revision: 2 })
    quote = fresh
    expect(await addLine('sales', { styleId: jacket, colourwayId: RED, sizes: grid([['52', 1]]) })).toMatchObject({ listUnitPrice: '445' })
    expect(await addLine('sales', { styleId: jacket, colourwayId: BLK, sizes: grid([['52', 1]]) })).toMatchObject({ listUnitPrice: '440' })
  })

  it("prices a consumer's quote from the company's base list, VAT included", async () => {
    quote = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P4 }, 201)).quote
    expect(quote.current).toMatchObject({ priceBasis: 'GROSS', paymentTermsId: null, priceList: { code: 'PL-BASE' } })
    // 450 net at 22% VAT.
    expect(await addLine('sales', { styleId: jacket, colourwayId: BLK, sizes: grid([['52', 1]]) })).toMatchObject({ listUnitPrice: '549', unitPrice: '549' })
  })

  it("fixes the rules of terms in use, never their names", async () => {
    const current = (await ok('finance', 'GET', `/sales/payment-terms/${terms.DEP10.id}`)).terms
    const fixed = await refused('finance', 'PATCH', `/sales/payment-terms/${terms.DEP10.id}`, { version: current.version, instalments: [{ sharePct: '40', from: 'ORDER', days: 10 }, { sharePct: '60', from: 'BEFORE_SHIPPING', days: 0 }] }, 409)
    expect(fixed.message).toMatch(/^DEP10 is used by 2 quote versions and 0 orders: its payment method, instalments and early-payment discount stay as they are/)
    const renamed = (await ok('finance', 'PATCH', `/sales/payment-terms/${terms.DEP10.id}`, { version: current.version, name: "Acconto 30% all'ordine, saldo prima della spedizione" })).terms
    expect(renamed).toMatchObject({ name: "Acconto 30% all'ordine, saldo prima della spedizione", version: current.version + 1, instalments: current.instalments })
  })
})
