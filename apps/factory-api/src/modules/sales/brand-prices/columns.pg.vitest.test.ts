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
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../../packages/factory-db/src/testing/second-brand'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { PRICE_CHECK_CAP } from './columns'

/**
 * The price check in the Orders list (customer page lane B-CP-018; design customer-page 11 §1.2, §3.1; review B4, B5) on the local
 * stack with the app's real routes: every seed (Brand Alpha = SEED-C1; the private rider SEED-R1 holds the many orders of the cap
 * test) and the second brand (Brand Beta). Test sessions hold the role templates' grants (B-CP-011: Sales holds no price grain).
 *
 *   - as Owner: each row's customer's price, check, difference and lines that differ; `priceMatch` narrows the list (Not equal,
 *     No customer price yet, Equal) and the overall totals; more than PRICE_CHECK_CAP orders with a price to check is refused in
 *     words; the summary of ONE customer counts its Not equal and No customer price yet orders (every status), past the cap too
 *   - as Sales worker / as Production manager: the four row keys absent, the term refused 403 in words, the summary 403
 *   - the brand wall: an Owner limited to Brand Beta asking Brand Alpha's summary gets the unknown customer's answer (404)
 *
 * Every name, number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs sales/brand-prices/columns`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' // B-OM-020: + DELETE (the take-back)

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'cp018-price-columns'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const PEOPLE = { owner: newId(), sales: newId(), production: newId(), betaOwner: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { owner: 'owner', sales: 'sales', production: 'production_manager', betaOwner: 'owner' }
const SESSIONS: Record<string, SessionContext> = {}
const PRICE_KEYS = ['brandPrice', 'priceMatch', 'priceDiff', 'priceNotEqualLines']

let h: Harness
let app: FastifyInstance
let beta: SecondBrand
let alpha: string
let rider: string
let blk: { styleId: string; colourwayId: string; sizes: string[] }
let red: { styleId: string; colourwayId: string; sizes: string[] }
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `cp018-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: Person, method: Method, url: string, status: number): Promise<Json> {
  const response = await call(session, method, url)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
const idsOf = async (person: Person, query: string): Promise<string[]> => (await ok(person, 'GET', `/sales/orders?${query}&limit=200`)).orders.map((row: Json) => row.id as string)

/** Brand Alpha's manual order typed by the Owner (BLK 6 at 100.00, RED 2 at 110.00: 820.00), with the customer's prices given. */
async function priced(ref: string, rows: (lines: { blk: string; red: string }) => Json[]): Promise<string> {
  const body = {
    companyId: companyA,
    partyId: alpha,
    customerRef: ref,
    lines: [
      { styleId: blk.styleId, colourwayId: blk.colourwayId, unitPrice: '100', sizes: blk.sizes.slice(0, 2).map((size) => ({ size, quantity: 3 })) },
      { styleId: red.styleId, colourwayId: red.colourwayId, unitPrice: '110', sizes: red.sizes.slice(0, 1).map((size) => ({ size, quantity: 2 })) },
    ],
  }
  const order = (await ok('owner', 'POST', '/sales/orders/manual', body, 201)).order
  const lines = await admin<{ id: string }>(`SELECT id FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [order.id])
  const given = rows({ blk: lines[0]!.id, red: lines[1]!.id })
  if (given.length > 0) await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: given })
  return order.id
}

let equal: string
let differs: string
let none: string

beforeAll(async () => {
  h = await startHarness('cp018_price_columns') // B-CP-022: test-database labels are at most 20 characters
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  beta = await seedSecondBrand({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  alpha = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [T])).id
  rider = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R1'`, [T])).id
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `cp018-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, PEOPLE[person], roleIds.get(role)])
    const template = templateOf(role)!
    const grants: Grant[] = [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: person === 'betaOwner' ? [beta.partyId] : 'all' }]
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants }
  }
  const lines = await admin<{ styleId: string; colourwayId: string; code: string; sizes: string[] }>(
    `SELECT l."styleId", l."colourwayId", c.code, (SELECT array_agg(s.size ORDER BY s.size) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) AS sizes
       FROM "SalesOrderLine" l JOIN "SalesOrder" o ON o.id = l."orderId" JOIN "Colourway" c ON c.id = l."colourwayId" WHERE o."tenantId" = $1 AND o.number = 'SEED-SO-0001' ORDER BY l.seq`,
    [T],
  )
  blk = lines.find((line) => line.code === 'BLK')!
  red = lines.find((line) => line.code === 'RED')!
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  equal = await priced('PO-CP018-EQ', (line) => [{ lineId: line.blk, unitPrice: '100', source: 'CUSTOMER_PO' }, { lineId: line.red, unitPrice: '110', source: 'CUSTOMER_PO' }])
  differs = await priced('PO-CP018-NE', (line) => [{ lineId: line.blk, unitPrice: '100', source: 'CUSTOMER_PO' }, { lineId: line.red, netAmount: 21_000, source: 'OFFICE' }])
  none = await priced('PO-CP018-NONE', () => [])
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('as Owner: the price check on each row and as a term of the list (B-CP-018)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('each row carries the customer’s price, the check, the difference and how many lines differ', async () => {
    const rows = (await ok('owner', 'GET', `/sales/orders?partyId=${alpha}&limit=200`)).orders as Json[]
    const row = (id: string) => rows.find((entry) => entry.id === id)!
    expect(row(equal)).toMatchObject({ netAmount: 82_000, brandPrice: 82_000, priceMatch: 'EQUAL', priceDiff: 0, priceNotEqualLines: 0 })
    expect(row(differs)).toMatchObject({ netAmount: 82_000, brandPrice: 81_000, priceMatch: 'NOT_EQUAL', priceDiff: 1_000, priceNotEqualLines: 1 })
    expect(row(none)).toMatchObject({ brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null, priceNotEqualLines: 0 })
  })

  it('priceMatch narrows the list to the orders that read so ("No customer price yet" is never Equal)', async () => {
    const notEqual = await idsOf('owner', `partyId=${alpha}&priceMatch=NOT_EQUAL`)
    expect(notEqual).toEqual([differs])
    expect(await idsOf('owner', `partyId=${alpha}&priceMatch=EQUAL`)).toEqual([equal])
    const missing = await idsOf('owner', `partyId=${alpha}&priceMatch=NO_BRAND_PRICE`)
    expect(missing).toContain(none)
    expect(missing).not.toContain(equal)
    expect(missing).not.toContain(differs)
    // The overall totals read the same filter (each total opens exactly its rows).
    expect((await ok('owner', 'GET', `/sales/orders/summary?partyId=${alpha}&priceMatch=NOT_EQUAL`)).all.orders.count).toBe(1)
  })

  it('the summary of one customer: its Not equal and No customer price yet orders, every status', async () => {
    const all = (await one<{ count: number }>(`SELECT count(*)::int AS count FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2`, [T, alpha])).count
    const summary = await ok('owner', 'GET', `/sales/brand-prices/summary?partyId=${alpha}`)
    expect(summary).toEqual({ partyId: alpha, priceNotEqualCount: 1, priceMissingCount: all - 2 })
    expect(await ok('owner', 'GET', `/sales/brand-prices/summary?partyId=${alpha}&companyId=${companyA}`)).toEqual(summary)
  })

  it(`more than ${PRICE_CHECK_CAP} orders to check is refused in words: narrow the list first; the summary still counts them`, async () => {
    const source = await one<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T])
    // The private rider's made-up orders (no lines, net 0), each with the customer's total of 0.00: Equal.
    await admin(
      `INSERT INTO "SalesOrder" (id, "tenantId", "companyId", "partyId", number, "orderDate", "taxMode", "billTo", "shipTo", status, currency)
       SELECT gen_random_uuid(), o."tenantId", o."companyId", $2, 'CP018-CAP-' || g, o."orderDate", o."taxMode", o."billTo", o."shipTo", 'CONFIRMED', o.currency FROM "SalesOrder" o, generate_series(1, $3::int) g WHERE o.id = $1`,
      [source.id, rider, PRICE_CHECK_CAP + 1],
    )
    await admin(
      `INSERT INTO "OrderBrandPrice" (id, "tenantId", "companyId", "partyId", "salesOrderId", "netAmount", currency, source, "enteredById", version)
       SELECT gen_random_uuid(), o."tenantId", o."companyId", o."partyId", o.id, 0, o.currency, 'OFFICE', $2, 1 FROM "SalesOrder" o WHERE o."tenantId" = $1 AND o.number LIKE 'CP018-CAP-%'`,
      [T, PEOPLE.owner],
    )
    const refused = await no('owner', 'GET', `/sales/orders?partyId=${rider}&priceMatch=EQUAL`, 400)
    expect(refused).toMatchObject({ message: 'Too many orders to check at once: narrow the list first.', issues: [{ path: 'query/priceMatch', message: 'Too many orders to check at once: narrow the list first.' }] })
    expect(await ok('owner', 'GET', `/sales/brand-prices/summary?partyId=${rider}`)).toMatchObject({ priceNotEqualCount: 0 })
  })
})

describe('the money wall and the brand wall (B-CP-018)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('as Sales worker / as Production manager: no price key on any row, the term refused 403 in words, the summary 403', async () => {
    for (const person of ['sales', 'production'] as const) {
      const response = await call(person, 'GET', `/sales/orders?partyId=${alpha}&limit=200`)
      if (response.statusCode === 200) expect(keysOf((response.json() as Json).orders).filter((key) => PRICE_KEYS.includes(key)), person).toEqual([])
      else expect(response.statusCode, person).toBe(403)
      const term = await no(person, 'GET', `/sales/orders?partyId=${alpha}&priceMatch=NOT_EQUAL`, 403)
      if (response.statusCode === 200) expect(term.message, person).toBe('Shown to people who see prices.')
      await no(person, 'GET', `/sales/brand-prices/summary?partyId=${alpha}`, 403)
    }
    expect((await no('sales', 'GET', `/sales/orders/summary?partyId=${alpha}&priceMatch=NOT_EQUAL`, 403)).message).toBe('Shown to people who see prices.')
  })

  it('the brand wall: an Owner limited to Brand Beta asking Brand Alpha’s summary gets an unknown customer’s answer', async () => {
    const theirs = await no('betaOwner', 'GET', `/sales/brand-prices/summary?partyId=${alpha}`, 404)
    const unknown = await no('betaOwner', 'GET', `/sales/brand-prices/summary?partyId=${newId()}`, 404)
    expect({ code: theirs.code, message: theirs.message }).toEqual({ code: unknown.code, message: unknown.message })
    expect(theirs.message).toBe('Customer not found.')
    // Its own customer: its own counts only (Brand Beta's order has no customer's price).
    expect(await ok('betaOwner', 'GET', `/sales/brand-prices/summary?partyId=${beta.partyId}`)).toEqual({ partyId: beta.partyId, priceNotEqualCount: 0, priceMissingCount: 1 })
    // Its list with the term holds none of Brand Alpha's orders.
    const ids = await idsOf('betaOwner', 'priceMatch=NO_BRAND_PRICE')
    for (const id of [equal, differs, none]) expect(ids).not.toContain(id)
  })
})

// ── B-OM-020 (order money tab; Owner D4): a difference accepted by hand leaves "Not equal" — the list, its totals, the summary ──
describe('B-OM-020: an accepted difference is no longer counted as Not equal (one rule for the list and the summary)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const notEqualCount = async () => (await ok('owner', 'GET', `/sales/brand-prices/summary?partyId=${alpha}`)).priceNotEqualCount as number

  it('accepted: the row says so and still reads Not equal; the Not equal term, its totals and the summary leave it out', async () => {
    expect(await notEqualCount()).toBe(1)
    await ok('owner', 'POST', `/sales/orders/${differs}/price-check/accept`, { ourNet: 82_000, brandNet: 81_000, reason: 'Agreed with the customer: 810.00.' })
    const rows = (await ok('owner', 'GET', `/sales/orders?partyId=${alpha}&limit=200`)).orders as Json[]
    expect(rows.find((entry) => entry.id === differs)).toMatchObject({ priceMatch: 'NOT_EQUAL', priceDiff: 1_000, priceAccepted: true })
    expect(rows.find((entry) => entry.id === equal)).toMatchObject({ priceAccepted: false })
    expect(await idsOf('owner', `partyId=${alpha}&priceMatch=NOT_EQUAL`)).toEqual([])
    expect((await ok('owner', 'GET', `/sales/orders/summary?partyId=${alpha}&priceMatch=NOT_EQUAL`)).all.orders.count).toBe(0)
    expect(await notEqualCount()).toBe(0)
  })

  it('taken back: counted as Not equal again', async () => {
    await ok('owner', 'DELETE', `/sales/orders/${differs}/price-check/accept`, { reason: 'Not confirmed in writing.' })
    expect(await idsOf('owner', `partyId=${alpha}&priceMatch=NOT_EQUAL`)).toEqual([differs])
    expect(await notEqualCount()).toBe(1)
  })

  it('a Sales worker never reads priceAccepted on a row', async () => {
    const response = await call('sales', 'GET', `/sales/orders?partyId=${alpha}&limit=200`)
    if (response.statusCode === 200) expect(keysOf((response.json() as Json).orders)).not.toContain('priceAccepted')
  })
})
// ── end B-OM-020 ──
