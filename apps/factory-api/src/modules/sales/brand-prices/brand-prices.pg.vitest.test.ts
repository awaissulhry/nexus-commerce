import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
import { liveMessageFor, liveViewFor } from '@nexus/factory-domain/events/live'
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { seedSecondBrand, type SecondBrand } from '../../../../../../packages/factory-db/src/testing/second-brand'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * The customer's price store and the price check of one order (customer page lane B-CP-017; design customer-page 11 §1.2, §2;
 * the money wall, Owner O1-O4; review B2, B3, B4, C2) on the local stack with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the …_customer_page_guards trigger are real), every
 * seed (Brand Alpha = the seeds' customer SEED-C1) and the second brand (factory-db testing/second-brand: Brand Beta, its order
 * and a PO file of its own). Test sessions hold the role templates' grants (B-CP-011: Sales holds no price grain).
 *
 *   - as Owner: the check of an order without a customer's price (No customer price yet, never Equal); prices typed per line
 *     (a unit price from the customer's PO, a line total typed by us) read Equal; a cent off reads Not equal with the
 *     difference ours − the customer's; the order's total row; a removal; the PO file named is marked priced (audited)
 *   - 409 with every row as it is now (a version read before, a line typed meanwhile); 400 by place (currency, not a line of this
 *     order, both or none of unit price and line total, a total with a unit price, Brand Beta's PO on Brand Alpha's order, a
 *     closed order)
 *   - the history: audit rows under OrderBrandPrice (the order as the record id), money-marked; none under the order; the event
 *     with ids only, and its live message sent to the Owner, never to a Production manager
 *   - the take-over of the customer's own request prices (source PORTAL, no office person); an office change makes it ours
 *   - as Sales worker / as Production manager: 403 on the read, the write refused (body and words); the brand wall: an Owner
 *     limited to Brand Beta gets Brand Alpha's order as an unknown one (404, the same words)
 *
 * Every name, number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs sales/brand-prices/brand-prices`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'cp017-brand-prices'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const companyA = sid('company:A')
const AT = new Date('2026-11-19T08:00:00.000Z')

const PEOPLE = { owner: newId(), sales: newId(), production: newId(), admin: newId(), betaOwner: newId() } as const
type Person = keyof typeof PEOPLE
const ROLE_OF: Record<Person, string> = { owner: 'owner', sales: 'sales', production: 'production_manager', admin: 'admin', betaOwner: 'owner' }
const SESSIONS: Record<string, SessionContext> = {}
/** A person's actor, as the live wall reads it. */
const actorOf = (person: Person): Actor => ({ audience: 'office', tenantId: T, grants: SESSIONS[person]!.grants })
function grantsOf(role: string, parties: Grant['parties'] = 'all'): Grant[] {
  const template = templateOf(role)!
  return [{ permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties }]
}

let h: Harness
let app: FastifyInstance
let beta: SecondBrand
let alpha: string
let blk: { styleId: string; colourwayId: string; sizes: string[] }
let red: { styleId: string; colourwayId: string; sizes: string[] }
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const call = (session: Person, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': `cp017-${run}-${++keys}` } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: Person, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: Person, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
/** Every key of an answer, at any depth (the money wall: no price-looking key reaches a no-price reader). */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])

/** A manual order of Brand Alpha typed by the Owner: 6 jackets in BLK at 100.00 (600.00) and 2 in RED at 110.00 (220.00). */
async function alphaOrder(ref: string): Promise<{ id: string; lines: { id: string; seq: number }[] }> {
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
  return { id: order.id, lines: await admin<{ id: string; seq: number }>(`SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [order.id]) }
}

/** A PO file of an order (the customer's purchase order, as the office files it). */
async function poFile(orderId: string, name: string): Promise<string> {
  const id = randomUUID()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: PEOPLE.owner }, (client) =>
    client.storedFile.createMany({
      data: [
        seedFile(T, {
          id,
          companyId: companyA,
          recordType: 'SalesOrder',
          recordId: orderId,
          kind: 'DOCUMENT',
          originalName: name,
          contentType: 'application/pdf',
          sizeBytes: 2048,
          storageKey: `t/${T}/c/${companyA}/2026/${randomUUID()}`,
          visibility: ['OFFICE'],
          partyId: null,
          status: 'AVAILABLE',
          availableAt: AT,
          storeAccountId: sid('files:account:r2'),
          createdAt: AT,
          updatedAt: AT,
          createdById: PEOPLE.owner,
        }),
      ],
    }),
  )
  return id
}

const audits = (orderId: string) => admin<Json>(`SELECT action, "recordType", "recordId", before, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'OrderBrandPrice' AND "recordId" = $2 ORDER BY at, id`, [T, orderId])
const outbox = (orderId: string) => admin<Json>(`SELECT type, version, "tenantId", "companyId", "siteId", subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'sales_order.brand_price_changed' AND subject = $2 ORDER BY "occurredAt", id`, [T, orderId])

beforeAll(async () => {
  h = await startHarness('cp017_brand_prices') // B-CP-022: test-database labels are at most 20 characters
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  beta = await seedSecondBrand({ db: h.database, namespace: NS })
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  alpha = (await one<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-C1'`, [T])).id
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const [person, role] of Object.entries(ROLE_OF) as Array<[Person, string]>) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `cp017-${person}-${run}@example.com`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, PEOPLE[person], roleIds.get(role)])
    SESSIONS[person] = { audience: 'office', tenantId: T, actorId: PEOPLE[person], grants: grantsOf(role, person === 'betaOwner' ? [beta.partyId] : 'all') }
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
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('as Owner: the customer’s price per line and for the order, and the price check (B-CP-017)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let order: { id: string; lines: { id: string; seq: number }[] }
  let po: string

  beforeAll(async () => {
    order = await alphaOrder('PO-CP017-1')
    po = await poFile(order.id, 'Brand Alpha PO 4471.pdf')
  })

  it('an order without a customer’s price reads "No customer price yet", never Equal; the Owner may write', async () => {
    const check = await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)
    expect(check).toMatchObject({ orderId: order.id, currency: 'EUR', mayWrite: { allowed: true, why: null }, fromRequest: null })
    expect(check.lines.map((line: Json) => [line.seq, line.pieces, line.ourAmount, line.priceMatch, line.brandAmount, line.row])).toEqual([
      [10, 6, 60_000, 'NO_BRAND_PRICE', null, null],
      [20, 2, 22_000, 'NO_BRAND_PRICE', null, null],
    ])
    expect(check.total).toMatchObject({ ourPrice: 82_000, brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceDiff: null, priceMissingLines: 2, priceNotEqualLines: 0, row: null })
  })

  it('a unit price from the customer’s PO and a line total typed by us read Equal; the PO file is marked priced', async () => {
    const check = await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, {
      currency: 'EUR',
      rows: [
        { lineId: order.lines[0]!.id, unitPrice: '100', source: 'CUSTOMER_PO', sourceFileId: po, note: 'PO 4471, page 2' },
        { lineId: order.lines[1]!.id, netAmount: 22_000, source: 'OFFICE' },
      ],
    })
    expect(check.lines.map((line: Json) => [line.seq, line.brandAmount, line.priceMatch, line.priceDiff])).toEqual([
      [10, 60_000, 'EQUAL', 0],
      [20, 22_000, 'EQUAL', 0],
    ])
    expect(check.lines[0].row).toMatchObject({ unitPrice: '100', netAmount: null, source: 'CUSTOMER_PO', sourceFile: { id: po, name: 'Brand Alpha PO 4471.pdf' }, note: 'PO 4471, page 2', enteredBy: { name: 'Made-up owner' }, version: 1 })
    expect(check.total).toMatchObject({ brandPrice: 82_000, priceMatch: 'EQUAL', priceDiff: 0, priceMissingLines: 0 })
    expect(await one(`SELECT priced FROM "StoredFile" WHERE id = $1`, [po])).toEqual({ priced: true })
    expect(await admin(`SELECT action, after FROM "AuditLog" WHERE "recordType" = 'StoredFile' AND "recordId" = $1 AND action = 'files.markPriced'`, [po])).toHaveLength(1)
  })

  it('a cent off reads Not equal with the difference ours − the customer’s, per line and for the order', async () => {
    const before = await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)
    const check = await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[1]!.id, netAmount: 21_999, source: 'OFFICE', version: before.lines[1].row.version }] })
    expect(check.lines[1]).toMatchObject({ brandAmount: 21_999, priceMatch: 'NOT_EQUAL', priceDiff: 1 })
    expect(check.lines[1].row.version).toBe(2)
    expect(check.total).toMatchObject({ brandPrice: 81_999, priceMatch: 'NOT_EQUAL', priceDiff: 1, priceNotEqualLines: 1 })
  })

  it('the order’s total row is the customer’s price for the whole order; the same body again changes nothing', async () => {
    const body = { rows: [{ lineId: null, netAmount: 82_000, source: 'CUSTOMER_PO' }] }
    const check = await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, body)
    expect(check.total).toMatchObject({ brandPrice: 82_000, row: { netAmount: 82_000, unitPrice: null, source: 'CUSTOMER_PO', version: 1 } })
    // A known line difference wins over an equal total.
    expect(check.total.priceMatch).toBe('NOT_EQUAL')
    const count = (await audits(order.id)).length
    await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ ...body.rows[0], version: 1 }] })
    expect((await audits(order.id)).length).toBe(count)
  })

  it('409 with every row as it is now: a version read before, a line typed meanwhile', async () => {
    const stale = await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[1]!.id, netAmount: 22_000, source: 'OFFICE', version: 1 }, { lineId: order.lines[0]!.id, unitPrice: '99', source: 'OFFICE' }] }, 409)
    expect(stale.message).toBe('Someone changed these prices meanwhile. Here they are now: read them again.')
    expect(stale.issues).toEqual([
      { path: 'body/rows/0/version', message: 'This customer\'s price is at version 2 now.' },
      { path: 'body/rows/1/version', message: 'The customer\'s price of this line was typed meanwhile (version 1): read it again.' },
    ])
    const removed = await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { remove: [{ id: newId(), version: 1 }] }, 409)
    expect(paths(removed)).toEqual(['body/remove/0/id'])
  })

  it('400 by place: the currency, not a line of this order, both or none of unit price and line total, a total with a unit price', async () => {
    const line = order.lines[0]!.id
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { currency: 'USD', rows: [] }, 400))).toEqual(['body/currency'])
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: newId(), unitPrice: '1', source: 'OFFICE' }] }, 400))).toEqual(['body/rows/0/lineId'])
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: line, unitPrice: '1', netAmount: 100, source: 'OFFICE', version: 1 }] }, 400))).toEqual(['body/rows/0/unitPrice'])
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: line, source: 'OFFICE', version: 1 }] }, 400))).toEqual(['body/rows/0/unitPrice'])
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: null, unitPrice: '1', source: 'OFFICE' }] }, 400))).toEqual(['body/rows/0/netAmount'])
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ unitPrice: '1', source: 'OFFICE' }] }, 400))).toEqual(['body/rows/0/lineId'])
    expect(paths(await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: line, unitPrice: '1', source: 'OFFICE', version: 1 }, { lineId: line, unitPrice: '2', source: 'OFFICE', version: 1 }] }, 400))).toEqual(['body/rows/1/lineId'])
    // Nothing moved.
    expect((await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)).lines[0].row).toMatchObject({ unitPrice: '100', version: 1 })
  })

  it('the brand wall in the store: Brand Beta’s PO never prices Brand Alpha’s order (400, its name unsaid)', async () => {
    const refused = await no('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '100', source: 'CUSTOMER_PO', sourceFileId: beta.fileId, version: 1 }] }, 400)
    expect(refused.issues).toEqual([{ path: 'body/rows/0/sourceFileId', message: 'Not a file of this order.' }])
    expect(JSON.stringify(refused)).not.toContain('Seed second brand')
    expect(await one(`SELECT priced FROM "StoredFile" WHERE id = $1`, [beta.fileId])).toEqual({ priced: false })
  })

  it('a removal: the line reads "No customer price yet" again; nothing is written on a closed or cancelled order', async () => {
    const before = await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)
    const check = await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { remove: [{ id: before.lines[1].row.id, version: before.lines[1].row.version }] })
    expect(check.lines[1]).toMatchObject({ priceMatch: 'NO_BRAND_PRICE', row: null })
    const closed = await alphaOrder('PO-CP017-CLOSED')
    await force(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now() WHERE id = $1`, [closed.id])
    const refused = await no('owner', 'PUT', `/sales/orders/${closed.id}/brand-prices`, { rows: [{ lineId: closed.lines[0]!.id, unitPrice: '100', source: 'OFFICE' }] }, 400)
    expect(refused.message).toBe('A closed or cancelled order keeps its prices.')
    expect((await ok('owner', 'GET', `/sales/orders/${closed.id}/price-check`)).mayWrite).toEqual({ allowed: false, why: 'A closed or cancelled order keeps its prices.' })
  })

  // ── B-OM-006 (order money tab M2-S2): where our price came from, per line, from the waterfall the order keeps ──
  it('B-OM-006: each line says where our price came from — the price list, set by hand, or changed since the quote', async () => {
    const priced = await alphaOrder('PO-OM006-1')
    const [first, second] = priced.lines
    // The waterfalls as an order made from a quote keeps them (copied from its quote lines), written with the rules off.
    const list = [{ kind: 'LIST', unitPrice: '100', source: { type: 'PriceListEntry', id: randomUUID() }, label: 'List price' }, { kind: 'NET', unitPrice: '100' }]
    const typed = [{ kind: 'MANUAL', unitPrice: '110', reasonCode: 'NEGOTIATED' }, { kind: 'NET', unitPrice: '110' }]
    await force(`UPDATE "SalesOrderLine" SET "priceSteps" = $2::jsonb WHERE id = $1`, [first!.id, JSON.stringify(list)])
    await force(`UPDATE "SalesOrderLine" SET "priceSteps" = $2::jsonb WHERE id = $1`, [second!.id, JSON.stringify(typed)])
    const check = await ok('owner', 'GET', `/sales/orders/${priced.id}/price-check`)
    expect(check.lines.map((line: Json) => [line.seq, line.ourPriceSource])).toEqual([
      [10, 'LIST'],
      [20, 'MANUAL'],
    ])
    // An amendment that changes the price drops the line's steps (the database's rule): "Changed since the quote".
    await force(`UPDATE "SalesOrderLine" SET "priceSteps" = NULL WHERE id = $1`, [first!.id])
    expect((await ok('owner', 'GET', `/sales/orders/${priced.id}/price-check`)).lines[0]).toMatchObject({ seq: 10, ourPriceSource: 'UNKNOWN' })
  })

  it('the history: audit rows under OrderBrandPrice with the order as the record id, money-marked; none under the order', async () => {
    const rows = await audits(order.id)
    expect(rows.map((row) => row.action).sort()).toEqual(['brandPrices.change', 'brandPrices.remove', 'brandPrices.set', 'brandPrices.set', 'brandPrices.set'])
    expect(rows.every((row) => row.recordType === 'OrderBrandPrice' && row.recordId === order.id)).toBe(true)
    const first = rows.find((row) => row.action === 'brandPrices.set' && row.after.lineId === order.lines[0]!.id)!
    expect(first.after).toMatchObject({ unitPrice: { $money: 'price', value: '100' }, netAmount: { $money: 'price', value: null }, note: { $money: 'price', value: 'PO 4471, page 2' }, source: 'CUSTOMER_PO', sourceFileId: po })
    const changed = rows.find((row) => row.action === 'brandPrices.change')!
    expect(changed.before).toMatchObject({ netAmount: { $money: 'price', value: 22_000 } })
    expect(changed.after).toMatchObject({ netAmount: { $money: 'price', value: 21_999 }, version: 2 })
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action LIKE 'brandPrices.%'`, [order.id])).toEqual([])
  })

  it('the event: ids only; its live message reaches the Owner, never a Production manager or a Sales worker', async () => {
    const events = await outbox(order.id)
    expect(events.length).toBe(4)
    for (const event of events) expect(event.payload).toEqual({ orderId: order.id, partyId: alpha })
    const definition = EVENT_CATALOGUE.get('sales_order.brand_price_changed', 1)
    const event = events[0]!
    const message = liveMessageFor({ eventId: newId(), type: event.type, version: event.version, context: 'brand-prices', tenantId: event.tenantId, companyId: event.companyId, siteId: event.siteId, subject: event.subject, correlationId: 'req', causationId: null, source: 'brandPrices.save', occurredAt: AT.toISOString(), payload: event.payload }, definition)!
    expect(liveViewFor(message, actorOf('production'), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, actorOf('sales'), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, actorOf('betaOwner'), EVENT_CATALOGUE)).toBeNull()
    expect(liveViewFor(message, actorOf('owner'), EVENT_CATALOGUE)?.fields).toEqual({ orderId: order.id })
  })
})

describe('the customer’s own prices of its request, taken over (source PORTAL)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let order: { id: string; lines: { id: string; seq: number }[] }
  const requestId = newId()

  beforeAll(async () => {
    order = await alphaOrder('PO-CP017-REQ')
    // Brand Alpha's accepted portal request whose order the accept did not price (made up; written as it stands).
    await force(`INSERT INTO "PortalOrderRequest" (id, "tenantId", "companyId", "partyId", number, status, currency, "salesOrderId", "decidedAt") VALUES ($1, $2, $3, $4, 'PR-CP017-1', 'ACCEPTED', 'EUR', $5, now())`, [requestId, T, companyA, alpha, order.id])
    // B-CP-076 (lead): the take-over pairs by the accept's line map only (its audit row), never by place: the made-up accept's map.
    const [first, second] = [newId(), newId()]
    await force(`INSERT INTO "PortalOrderRequestLine" (id, "tenantId", "partyId", "requestId", seq, "brandUnitPrice") VALUES ($1, $2, $3, $4, 10, 100), ($5, $2, $3, $4, 20, 105)`, [first, T, alpha, requestId, second])
    const lineOf = (seq: number) => order.lines.find((line) => line.seq === seq)!.id
    const lineMap = [{ requestLineId: first, requestSeq: 10, into: [lineOf(10)] }, { requestLineId: second, requestSeq: 20, into: [lineOf(20)] }]
    await force(`INSERT INTO "AuditLog" (id, "tenantId", "companyId", at, audience, "actorId", action, "recordType", "recordId", after, "requestId") VALUES ($1, $2, $3, now(), 'OFFICE', $4, 'portalOrdering.accept', 'PortalOrderRequest', $5, $6::jsonb, 'cp-076-made-up')`, [newId(), T, companyA, newId(), requestId, JSON.stringify({ status: 'ACCEPTED', as: 'ORDER', lineMap })])
  })

  it('the check names the request; the take-over writes PORTAL rows (no office person) and reads the difference', async () => {
    const before = await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)
    expect(before.fromRequest).toEqual({ requestId, number: 'PR-CP017-1', lines: 2 })
    const check = await ok('owner', 'POST', `/sales/orders/${order.id}/brand-prices/from-request`, { requestId })
    expect(check.lines.map((line: Json) => [line.seq, line.row.source, line.row.enteredBy, line.priceMatch, line.priceDiff])).toEqual([
      [10, 'PORTAL', null, 'EQUAL', 0],
      [20, 'PORTAL', null, 'NOT_EQUAL', 1_000],
    ])
    expect(check.fromRequest).toBeNull()
    expect((await audits(order.id)).map((row) => row.action)).toEqual(['brandPrices.takeOver', 'brandPrices.takeOver'])
    expect((await no('owner', 'POST', `/sales/orders/${order.id}/brand-prices/from-request`, { requestId }, 409)).message).toBe("Nothing to take over: the customer's request names no price for a line that has none yet.")
  })

  it('an office change of a PORTAL row makes it ours: the source sent and who typed it', async () => {
    const before = await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)
    const check = await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[1]!.id, unitPrice: '110', source: 'CUSTOMER_PO', version: before.lines[1].row.version }] })
    expect(check.lines[1].row).toMatchObject({ source: 'CUSTOMER_PO', enteredBy: { name: 'Made-up owner' }, version: 2 })
    expect(check.lines[1].priceMatch).toBe('EQUAL')
  })
})

describe('the money wall and the brand wall', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let order: { id: string; lines: { id: string; seq: number }[] }

  beforeAll(async () => {
    order = await alphaOrder('PO-CP017-WALL')
    await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '90', source: 'OFFICE' }] })
  })

  it('as Sales worker: the read is refused in words, a body is refused key by key, an empty one in words', async () => {
    const read = await no('sales', 'GET', `/sales/orders/${order.id}/price-check`, undefined, 403)
    expect(read.message).toBe('Shown to people who see prices.')
    const body = await no('sales', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '100', source: 'OFFICE', version: 1 }] }, 403)
    expect(paths(body)).toContain('rows')
    expect((await no('sales', 'PUT', `/sales/orders/${order.id}/brand-prices`, {}, 403)).message).toBe('Shown to people who see prices.')
    expect((await no('sales', 'POST', `/sales/orders/${order.id}/brand-prices/from-request`, {}, 403)).message).toBe('Shown to people who see prices.')
    // Nothing moved.
    expect((await ok('owner', 'GET', `/sales/orders/${order.id}/price-check`)).lines[0].row).toMatchObject({ unitPrice: '90', version: 1 })
  })

  it('as Production manager and as Administrator: 403; the order they read names no customer’s price', async () => {
    for (const person of ['production', 'admin'] as const) {
      await no(person, 'GET', `/sales/orders/${order.id}/price-check`, undefined, 403)
      await no(person, 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '100', source: 'OFFICE', version: 1 }] }, 403)
    }
    const response = await call('production', 'GET', `/sales/orders/${order.id}`)
    if (response.statusCode === 200) expect(keysOf(response.json()).filter((key) => ['brandPrice', 'priceMatch', 'priceDiff', 'brandAmount', 'priceNotEqualLines'].includes(key))).toEqual([])
  })

  it('the brand wall: an Owner limited to Brand Beta gets Brand Alpha’s order as an unknown one', async () => {
    const unknown = newId()
    for (const [method, suffix, body] of [['GET', 'price-check', undefined], ['PUT', 'brand-prices', { rows: [] }], ['POST', 'brand-prices/from-request', {}]] as const) {
      const theirs = await no('betaOwner', method, `/sales/orders/${order.id}/${suffix}`, body, 404)
      const none = await no('betaOwner', method, `/sales/orders/${unknown}/${suffix}`, body, 404)
      expect({ code: theirs.code, message: theirs.message }).toEqual({ code: none.code, message: none.message })
    }
    // Brand Beta's own order is its to price (it has no lines here: a total only).
    const own = await ok('betaOwner', 'PUT', `/sales/orders/${beta.salesOrderId}/brand-prices`, { rows: [{ lineId: null, netAmount: 1_000, source: 'OFFICE' }] })
    expect(own.total.row).toMatchObject({ netAmount: 1_000 })
    expect(JSON.stringify(own)).not.toContain(alpha)
  })
})

// ── B-CP-025 (customer page plan C4; review B3): the customer's price history stays with price holders ──
describe('the price history: never on the order’s timeline, only for price holders in the audit', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let order: { id: string; lines: { id: string; seq: number }[] }
  let rowId: string

  beforeAll(async () => {
    order = await alphaOrder('PO-CP025-HISTORY')
    const check = await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '95', source: 'CUSTOMER_PO', note: 'Customer says 95' }] })
    rowId = check.lines[0].row.id
    await ok('owner', 'PUT', `/sales/orders/${order.id}/brand-prices`, { remove: [{ id: rowId, version: 1 }] })
  })

  it('the order’s thread timeline (the dock) reads no customer’s price row, for the Owner, a Sales worker or a Production manager', async () => {
    for (const person of ['owner', 'sales', 'production'] as const) {
      const response = await call(person, 'GET', `/threads/SalesOrder/${order.id}/timeline?kinds=change`)
      if (response.statusCode === 403) continue // no threads.read: nothing to read at all
      expect(response.statusCode, response.body).toBe(200)
      expect(response.body, person).not.toContain('brandPrices.')
      expect(response.body, person).not.toContain(rowId)
      expect(response.body, person).not.toContain('Customer says 95')
    }
    // The order's own history names none either; the customer's prices are a history of their own.
    expect(JSON.stringify((await ok('owner', 'GET', `/audit/SalesOrder/${order.id}`)).entries)).not.toContain('brandPrices.')
  })

  it('as Sales worker / as Administrator: the audit list and the record history leave them out; the Owner reads them', async () => {
    for (const person of ['sales', 'admin'] as const) {
      expect((await ok(person, 'GET', `/audit?recordType=OrderBrandPrice&recordId=${order.id}`)).entries, person).toEqual([])
      expect((await ok(person, 'GET', `/audit/OrderBrandPrice/${order.id}`)).entries, person).toEqual([])
      expect((await ok(person, 'GET', '/audit?limit=200')).entries.filter((entry: Json) => entry.recordType === 'OrderBrandPrice'), person).toEqual([])
    }
    const history = (await ok('owner', 'GET', `/audit/OrderBrandPrice/${order.id}`)).entries
    expect(history.map((entry: Json) => entry.action)).toEqual(['brandPrices.remove', 'brandPrices.set'])
    expect(history[1].after).toMatchObject({ rowId, unitPrice: '95', note: 'Customer says 95' })
  })

  it('the brand wall: an Owner limited to Brand Beta reads none of Brand Alpha’s price history', async () => {
    expect((await ok('betaOwner', 'GET', `/audit/OrderBrandPrice/${order.id}`)).entries).toEqual([])
  })
})
// ── end B-CP-025 ──
