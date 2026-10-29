import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedShipping, type ShippingSeed } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { afterAccept, afterAcceptanceHandler } from '../quotes/after-acceptance'
import { orderHandlers } from './handlers'
import { moneySettlementPort, useOrderSettlement } from './settlement'

/**
 * Sales orders from the accepted quote (B-W1-25; SAL-200, SAL-203, SAL-204, SAL-206, SAL-214; A1 §2.5 "Sales order"; PLAN
 * §4.7 07-order and "Closing the order") on the local stack: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security, the column grants and the …_sales_guards triggers are real), the real app with the
 * real office sign-in and the real one-off link for the acceptance, and a second app with test sessions for the moves
 * and the walls. Four made-up tenants from the factory-db seeds up to shipping (SEED-SO-0002 for the brand P1: 7
 * jackets, WO-0001 released, quality released 3, SH-0001 SHIPPED with 2): tenant A also quotes SEED-JKT-01 and has it
 * accepted by link; in tenants B, C and D SEED-SO-0002 is cut down to the 2 jackets SH-0001 shipped, so it ships in full.
 * The close guard asks the money module's own settlement (B-W1-51); where a test needs a settled order without invoicing
 * one, it puts a test port in place (`useOrderSettlement`). Every name, price and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs orders`.
 */

let h: Harness
let app: FastifyInstance
let sales: Browser

const NS = { a: 'orders-a', b: 'orders-b', c: 'orders-c', d: 'orders-d' } as const
type TenantKey = keyof typeof NS
const idIn = (tenant: TenantKey, key: string) => seedUuid(NS[tenant], key)
const T = Object.fromEntries((Object.keys(NS) as TenantKey[]).map((key) => [key, idIn(key, 'tenant')])) as Record<TenantKey, string>
const companyA = idIn('a', 'company:A')
const companyB = idIn('a', 'company:B')
const siteA = idIn('a', 'site:A1')
const P1 = idIn('a', 'party:P1')
const P3 = idIn('a', 'party:P3')
const jacket = idIn('a', 'product:style:JKT-01')
const BLK = idIn('a', 'product:colourway:JKT-01:BLK')
const RED = idIn('a', 'product:colourway:JKT-01:RED')
const YEAR = businessDate(new Date()).slice(0, 4)
const TODAY = businessDate(new Date())
const FAKE_VAT = '12345670009'
const seeded = {} as Record<TenantKey, ShippingSeed>

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
let counter = 0
const key = (label = 'k'): string => `ord-${label}-${++counter}-${newId()}`

// ---- sessions of the second app (test authenticator) -----------------------------------------------------------------

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (tenant: TenantKey, permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): (() => SessionContext) => () => ({
  audience: 'office',
  tenantId: T[tenant],
  actorId: newId(),
  grants: [grant(permissions, companies, parties)],
})
const MANAGE: Permission[] = ['orders.view', 'orders.manage', 'money.price', 'money.cost']
const CLOSE: Permission[] = ['orders.view', 'orders.close', 'money.price']
const SESSIONS: Record<string, () => SessionContext> = {
  ...Object.fromEntries((Object.keys(NS) as TenantKey[]).flatMap((tenant) => [
    [`${tenant}.sales`, office(tenant, MANAGE)],
    [`${tenant}.finance`, office(tenant, CLOSE)],
  ])),
  'a.viewer': office('a', ['orders.view']),
  'a.noOrders': office('a', ['quotes.view', 'money.price']),
  'a.companyB': office('a', MANAGE, [companyB]),
  'a.otherParty': office('a', MANAGE, 'all', [P3]),
  'a.floor': () => ({ audience: 'floor', tenantId: T.a, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['floor.work', ...MANAGE], companies: [companyA], sites: [siteA], parties: 'all' }] }),
  'a.partner': () => ({ audience: 'partner', tenantId: T.a, actorId: newId(), partyId: P1, grants: [{ permissions: MANAGE, companies: 'all', sites: 'all', parties: [P1] }] }),
}

async function call(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
  const response = await app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key(session) }) }, ...(body === undefined ? {} : { payload: body as object }) })
  return { status: response.statusCode, body: response.json() as Json }
}
async function ok(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}
async function refused(session: string, method: 'GET' | 'POST' | 'PUT', url: string, body: unknown, status: number): Promise<Json> {
  const answer = await call(session, method, url, body)
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body.error
}

// ---- the quote, its send and its acceptance (the real app) --------------------------------------------------------------

async function as(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200, headers: Record<string, string> = {}): Promise<Json> {
  const answer = await browser.send(method, url, method === 'GET' ? undefined : (body ?? {}), { headers })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}
const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
const BLK_GRID = grid([['50', 2], ['52', 4], ['54', 2]])
const RED_GRID = grid([['50', 1], ['52', 3], ['54', 2]])
const PROMISE = addDays(TODAY, 60)

/** A quote for P1 (8 × 450 + 6 × 440 = 6240.00 net, 7612.80 gross, deposit 30 % = 2283.84), sent and accepted by link. */
async function acceptedQuote(): Promise<{ quoteId: string; versionId: string; number: string }> {
  let quote = (await as(sales, 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-0077', promiseDate: PROMISE }, 201)).quote
  quote = (await as(sales, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' }, 201)).quote
  quote = (await as(sales, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jacket, colourwayId: RED, sizes: RED_GRID, unitPrice: '440' }, 201)).quote
  const before = h.ses.mails.length
  const sent = await as(sales, 'POST', `/sales/quotes/${quote.id}/send`, { version: quote.version }, 200, { 'idempotency-key': key('send') })
  const mail = h.ses.mails.slice(before).find((entry) => entry.outboundId === sent.sent?.emailId)!
  const token = decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '')
  const accepted = await h.app.inject({
    method: 'POST',
    url: '/link/quote/accept',
    headers: { 'x-factory-link': token, 'user-agent': 'Mozilla/5.0 (Customer test browser)', 'idempotency-key': key('accept') },
    payload: { versionId: quote.current.id, typedName: 'Anna Finta', email: 'buyer.p1@example.com' },
  })
  expect(accepted.statusCode, accepted.body).toBe(200)
  return { quoteId: quote.id, versionId: quote.current.id, number: quote.number }
}

const systemCaller = (tenant: TenantKey) => callerFor(h.database, systemContext(T[tenant], newId()))
const handler = (name: string) => orderHandlers().find((entry) => entry.name === name)!
const envelope = (tenant: TenantKey, type: string, payload: Json) => ({ eventId: newId(), type, version: 1, tenantId: T[tenant], payload }) as never
async function released(tenant: TenantKey) {
  const production = seeded[tenant].quality.production
  await handler('sales.ordersFollowWorkOrders').handle(envelope(tenant, 'workorder.released', { workOrderId: production.workOrderId, number: 'SEED-WO-0001', salesOrderIds: [production.salesOrderId] }), { caller: systemCaller(tenant), attempt: 1 })
}
async function shipped(tenant: TenantKey, to = 'SHIPPED') {
  await handler('sales.ordersFollowShipments').handle(envelope(tenant, 'shipment.status_changed', { shipmentId: seeded[tenant].shipmentId, number: 'SEED-SH-0001', from: 'PACKED', to }), { caller: systemCaller(tenant), attempt: 1 })
}
/** The money module's order.fully_settled event, as the worker hands it to the handler (the trigger only). */
async function settledEvent(tenant: TenantKey, orderId: string): Promise<void> {
  await handler('sales.ordersFollowSettlement').handle(envelope(tenant, 'order.fully_settled', { orderId, partyId: idIn(tenant, 'party:P1') }), { caller: systemCaller(tenant), attempt: 1 })
}
/** A test port: these orders are settled; every other order asks the money module. */
function settledForTest(orderIds: readonly string[]): void {
  useOrderSettlement({
    settlementOf: async (db, order) => (orderIds.includes(order.id) ? { settled: true, missing: [], source: 'test' } : moneySettlementPort.settlementOf(db, order)),
  })
}
const orderUrl = (id: string) => `/sales/orders/${id}`
const statusOf = async (orderId: string) => (await one<{ status: string }>('SELECT status::text AS status FROM "SalesOrder" WHERE id = $1', [orderId])).status
const auditsOf = (orderId: string) => admin<{ action: string; before: Json; after: Json; reason: string | null; audience: string }>(`SELECT action, before, after, reason, audience::text AS audience FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 ORDER BY at, id`, [orderId])
const statusEvents = (orderId: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.status_changed' AND subject = $1 ORDER BY "occurredAt", id`, [orderId])

/** SEED-SO-0002 cut down to what SH-0001 shipped (BLK 50 and RED 52, one each), while it is still CONFIRMED. */
async function cutDownToShipped(tenant: TenantKey): Promise<void> {
  const orderId = seeded[tenant].quality.production.salesOrderId
  await admin(
    `DELETE FROM "SalesOrderLineSize" s USING "SalesOrderLine" l, "Colourway" c
      WHERE s."lineId" = l.id AND c.id = l."colourwayId" AND l."orderId" = $1 AND NOT ((c.code = 'BLK' AND s.size = '50') OR (c.code = 'RED' AND s.size = '52'))`,
    [orderId],
  )
  await admin('UPDATE "SalesOrderLine" SET quantity = 1 WHERE "orderId" = $1', [orderId])
}

beforeAll(async () => {
  h = await startHarness('sales_orders')
  h.clock.set(new Date())
  for (const tenant of Object.keys(NS) as TenantKey[]) {
    await seedCore({ db: h.database, namespace: NS[tenant] })
    if (tenant === 'a') {
      await seedCompliance({ db: h.database, namespace: NS.a }) // the product and parties seeds come with it
      await seedCosting({ db: h.database, namespace: NS.a })
    }
    seeded[tenant] = await seedShipping({ db: h.database, namespace: NS[tenant] })
  }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T.a, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  // Company A's letterhead, its quote series (its seeded SALES_ORDER series is closed for the first acceptance),
  // a FAKE file store and a FAKE mail account with a verified conversation address.
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  await admin(`INSERT INTO "NumberSeries" (id, "tenantId", "companyId", kind, code, "scopeKey", reset, pattern, fiscal) VALUES ($1, $2, $3, 'QUOTE', 'MAIN', $4, 'YEARLY', 'Q-{YYYY}-{N:4}', false)`, [newId(), T.a, companyA, YEAR])
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), T.a])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, T.a])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'sales@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), T.a, companyA, ses],
  )
  const tenantA: TestTenant = { id: T.a, slug: NS.a, companies: [{ id: companyA, code: 'SCA' }] }
  const salesUser = await addUser(h, tenantA, { email: 'olga.orders@seed-a.example.com', role: 'sales' })
  sales = new Browser(h.app)
  expect((await sales.signIn(NS.a, salesUser.email, salesUser.password)).status).toBe(200)
  await enrolTotp(h, sales)
  for (const tenant of ['b', 'c', 'd'] as const) await cutDownToShipped(tenant)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 300_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let waiting: { quoteId: string; versionId: string; number: string }
let waitingOrderId: string
let accepted: { quoteId: string; versionId: string; number: string }
let order: Json

describe('the order from the accepted quote (SAL-200, SAL-203; Owner answer S1: made at acceptance)', () => {
  it('without a SALES_ORDER series the deposit is still asked and the order waits; the office makes it once a series exists', async () => {
    const series = `UPDATE "NumberSeries" SET status = $3 WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'SALES_ORDER'`
    await admin(series, [T.a, companyA, 'CLOSED'])
    waiting = await acceptedQuote()
    expect((await admin('SELECT count(*)::int AS n FROM "SalesOrder" WHERE "quoteVersionId" = $1', [waiting.versionId]))[0]!.n).toBe(0)
    const deposit = await one('SELECT id, status, "orderId" FROM "DepositRequest" WHERE "quoteVersionId" = $1', [waiting.versionId])
    expect(deposit).toMatchObject({ status: 'OPEN', orderId: null })
    const step = await one(`SELECT after FROM "AuditLog" WHERE action = 'quotes.afterAccept' AND "recordId" = $1`, [waiting.quoteId])
    expect(step.after).toMatchObject({ orderId: null, orderCreated: false, orderWaits: 'NO_SALES_ORDER_SERIES', depositCreated: true })
    const noSeries = await refused('a.sales', 'POST', '/sales/orders', { quoteVersionId: waiting.versionId }, 409)
    expect(noSeries.message).toMatch(/no active SALES_ORDER number series/)

    await admin(series, [T.a, companyA, 'ACTIVE']) // the seed's (packages/factory-db/seed/numbering.ts)
    const made = await ok('a.sales', 'POST', '/sales/orders', { quoteVersionId: waiting.versionId }, 201)
    expect(made).toMatchObject({ created: true, order: { number: `SO-${YEAR}-0001`, status: 'CONFIRMED', chain: { quote: { id: waiting.quoteId, versionId: waiting.versionId } } } })
    waitingOrderId = made.order.id
    expect((await one('SELECT "orderId" FROM "DepositRequest" WHERE id = $1', [deposit.id])).orderId).toBe(waitingOrderId)
    // Asked again: the same order, nothing new.
    const again = await ok('a.sales', 'POST', '/sales/orders', { quoteVersionId: waiting.versionId }, 200)
    expect(again).toMatchObject({ created: false, order: { id: waitingOrderId } })
    expect((await admin('SELECT count(*)::int AS n FROM "SalesOrder" WHERE "quoteVersionId" = $1', [waiting.versionId]))[0]!.n).toBe(1)
  })

  it('the acceptance makes the order CONFIRMED in its own step: lines, sizes, prices, costs, tax mode, addresses, dates as accepted', async () => {
    accepted = await acceptedQuote()
    const version = await one('SELECT "taxMode"::text AS "taxMode", currency, language, "billTo", "shipTo", "paymentTerms", "promiseDate", "netAmount", "vatAmount", "grossAmount", "costAmount", "noWithdrawal" FROM "QuoteVersion" WHERE id = $1', [accepted.versionId])
    order = await one('SELECT *, "promiseDate"::text AS promise, "originalPromiseDate"::text AS original, "orderDate"::text AS day FROM "SalesOrder" WHERE "quoteVersionId" = $1', [accepted.versionId])
    expect(order).toMatchObject({
      number: `SO-${YEAR}-0002`,
      companyId: companyA,
      partyId: P1,
      customerRef: 'RFQ-0077',
      status: 'CONFIRMED',
      taxMode: 'IT_B2B',
      currency: 'EUR',
      language: version.language,
      billTo: version.billTo,
      shipTo: version.shipTo,
      paymentTerms: version.paymentTerms,
      netAmount: 624000,
      vatAmount: version.vatAmount,
      grossAmount: 761280,
      costAmount: version.costAmount,
      depositRequired: true,
      noWithdrawal: false,
      priority: 0,
      cancelReason: null,
      closedAt: null,
    })
    expect([order.promise, order.original, order.day]).toEqual([PROMISE, PROMISE, TODAY])
    // The lines: each quote line, its size grid, its price on the version's basis (NET for a business), its cost.
    const quoteLines = await admin('SELECT id, seq, "styleRevisionId", "unitPrice"::text AS "unitPrice", "netAmount", "vatAmount", "unitCost"::text AS "unitCost", "costAmount" FROM "QuoteLine" WHERE "versionId" = $1 ORDER BY seq', [accepted.versionId])
    const lines = await admin('SELECT id, seq, "quoteLineId", "styleId", "styleRevisionId", "colourwayId", kind::text AS kind, quantity, "unitPrice"::text AS "unitPrice", "netAmount", "vatAmount", "vatRatePct"::text AS "vatRatePct", "unitCost"::text AS "unitCost", "costAmount" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [order.id])
    expect(lines).toHaveLength(2)
    for (const [index, line] of lines.entries()) {
      const source = quoteLines[index]!
      const revision = source.styleRevisionId ? await one('SELECT status::text AS status FROM "StyleRevision" WHERE id = $1', [source.styleRevisionId]) : null
      expect(line).toMatchObject({ quoteLineId: source.id, seq: source.seq, styleId: jacket, kind: 'SIZE_GRID', unitPrice: source.unitPrice, netAmount: source.netAmount, vatAmount: source.vatAmount, unitCost: source.unitCost, costAmount: source.costAmount, vatRatePct: '22.00' })
      expect(line.styleRevisionId).toBe(revision?.status === 'RELEASED' ? source.styleRevisionId : null)
    }
    expect(lines.map((line) => [line.colourwayId, line.quantity, line.unitPrice])).toEqual([[BLK, 8, '450.000000'], [RED, 6, '440.000000']])
    const sizes = await admin('SELECT l.seq, s.size, s.quantity FROM "SalesOrderLineSize" s JOIN "SalesOrderLine" l ON l.id = s."lineId" WHERE l."orderId" = $1 ORDER BY l.seq, s.size', [order.id])
    expect(sizes.map((row) => [row.seq, row.size, row.quantity])).toEqual([[10, '50', 2], [10, '52', 4], [10, '54', 2], [20, '50', 1], [20, '52', 3], [20, '54', 2]])
    // The deposit request names it; the step's audit row says so; sales_order.created follows.
    expect(await one('SELECT status, "orderId" FROM "DepositRequest" WHERE "quoteVersionId" = $1', [accepted.versionId])).toEqual({ status: 'OPEN', orderId: order.id })
    const step = await one(`SELECT after FROM "AuditLog" WHERE action = 'quotes.afterAccept' AND "recordId" = $1`, [accepted.quoteId])
    expect(step.after).toMatchObject({ orderId: order.id, orderCreated: true, orderWaits: null })
    const created = await one(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.created' AND subject = $1`, [order.id])
    expect(created.payload).toMatchObject({ orderId: order.id, number: order.number, quoteId: accepted.quoteId, versionId: accepted.versionId, partyId: P1 })
    expect(created.payload.depositRequestIds).toHaveLength(1)
    const made = (await auditsOf(order.id)).find((row) => row.action === 'orders.make')!
    expect(made.after).toMatchObject({ number: order.number, status: 'CONFIRMED', originalPromiseDate: PROMISE, pieces: 14, netAmount: { $money: 'price', value: 624000 } })
  })

  it('a second run of the step after the acceptance (the worker backstop, a replay, the office) makes no second order', async () => {
    const caller = systemCaller('a')
    const replay = await afterAccept(caller, { quoteId: accepted.quoteId, versionId: accepted.versionId })
    expect(replay.order).toEqual({ id: order.id, number: order.number })
    const event = await one(`SELECT payload FROM "OutboxEvent" WHERE type = 'quote.accepted' AND subject = $1`, [accepted.quoteId])
    await afterAcceptanceHandler().handle({ eventId: newId(), type: 'quote.accepted', version: 1, tenantId: T.a, payload: event.payload } as never, { caller, attempt: 1 })
    const office = await ok('a.sales', 'POST', '/sales/orders', { quoteVersionId: accepted.versionId }, 200)
    expect(office).toMatchObject({ created: false, order: { id: order.id } })
    expect((await admin('SELECT count(*)::int AS n FROM "SalesOrder" WHERE "quoteVersionId" = $1', [accepted.versionId]))[0]!.n).toBe(1)
    expect((await admin(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'sales_order.created' AND subject = $1`, [order.id]))[0]!.n).toBe(1)
    expect((await admin('SELECT count(*)::int AS n FROM "DepositRequest" WHERE "quoteVersionId" = $1', [accepted.versionId]))[0]!.n).toBe(1)
  })

  it('the record (sales, signed in): lines with size grids and per-size progress, the chain, the settlement, what comes next', async () => {
    const { order: record } = await as(sales, 'GET', orderUrl(order.id))
    expect(record).toMatchObject({
      id: order.id,
      number: order.number,
      status: 'CONFIRMED',
      priceBasis: 'NET',
      promiseDate: PROMISE,
      originalPromiseDate: PROMISE,
      daysLate: 0,
      netAmount: 624000,
      grossAmount: 761280,
      chain: { quote: { id: accepted.quoteId, number: accepted.number, versionId: accepted.versionId, revision: 1 }, workOrders: [], shipments: [], invoices: [] },
      settlement: { settled: false, source: 'invoicing' },
      actions: [
        { action: 'changePromise', allowed: true },
        { action: 'cancel', allowed: true, held: null },
      ],
      progress: { ordered: 14, inWorkOrders: 0, made: null, released: 0, shipped: 0, invoiced: '0', toShip: 14 },
    })
    // The money module's own answer: nothing shipped, nothing invoiced.
    expect(record.settlement.missing.map((gap: Json) => gap.code)).toEqual(expect.arrayContaining(['NOT_SHIPPED', 'NO_INVOICE']))
    expect(record.chain.depositRequests).toEqual([expect.objectContaining({ orderId: order.id, quoteVersionId: accepted.versionId, status: 'OPEN', amount: 228384 })])
    expect(record.lines.map((line: Json) => [line.seq, line.colourway.code, line.unitPrice, line.sizes.map((size: Json) => [size.size, size.quantity, size.progress.ordered, size.progress.made])])).toEqual([
      [10, 'BLK', '450', [['50', 2, 2, null], ['52', 4, 4, null], ['54', 2, 2, null]]],
      [20, 'RED', '440', [['50', 1, 1, null], ['52', 3, 3, null], ['54', 2, 2, null]]],
    ])
    // The sales template sees prices, not costs.
    expect(record).not.toHaveProperty('costAmount')
    expect(record.lines[0]).not.toHaveProperty('unitCost')
  })
})

describe('dates (SAL-206): a new promise needs a reason; the first promise never changes', () => {
  it('changes the promise of the order and of a line, keeps the first promise, lists who and why', async () => {
    const later = addDays(TODAY, 75)
    const missing = await refused('a.sales', 'PUT', `${orderUrl(order.id)}/promise`, { version: order.version, promiseDate: later, reason: '   ' }, 400)
    expect(missing.issues.map((issue: Json) => issue.path)).toContain('body/reason')
    const past = await refused('a.sales', 'PUT', `${orderUrl(order.id)}/promise`, { version: order.version, promiseDate: addDays(TODAY, -1), reason: 'Leather late.' }, 400)
    expect(past.issues).toEqual([{ path: 'body/promiseDate', message: `A new promise is a day from today (${TODAY}) on.` }])
    const stale = await refused('a.sales', 'PUT', `${orderUrl(order.id)}/promise`, { version: order.version + 5, promiseDate: later, reason: 'Leather late.' }, 409)
    expect(stale.issues).toEqual([{ path: 'version', message: `The current version is ${order.version}.` }])

    const changed = (await ok('a.sales', 'PUT', `${orderUrl(order.id)}/promise`, { version: order.version, promiseDate: later, reason: 'The red leather arrives two weeks late.' })).order
    expect(changed).toMatchObject({ promiseDate: later, originalPromiseDate: PROMISE, version: order.version + 1 })
    expect(changed.promiseHistory).toEqual([expect.objectContaining({ from: PROMISE, to: later, lineIds: [], reason: 'The red leather arrives two weeks late.' })])
    const red = changed.lines.find((line: Json) => line.colourway.code === 'RED')
    const lineLater = addDays(TODAY, 90)
    const lineChanged = (await ok('a.sales', 'PUT', `${orderUrl(order.id)}/promise`, { version: changed.version, promiseDate: lineLater, reason: 'Red needs a second dye bath.', lineIds: [red.id] })).order
    expect(lineChanged.lines.map((line: Json) => [line.colourway.code, line.promiseDate])).toEqual([['BLK', null], ['RED', lineLater]])
    expect(lineChanged).toMatchObject({ promiseDate: later, originalPromiseDate: PROMISE })
    expect(lineChanged.promiseHistory[0]).toMatchObject({ from: later, to: lineLater, lineIds: [red.id], reason: 'Red needs a second dye bath.' })
    expect((await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.promise_changed' AND subject = $1 ORDER BY "occurredAt"`, [order.id])).map((row) => row.payload.previous)).toEqual([PROMISE, later])
    // The database holds the first promise for every login, the owner included.
    await expect(admin(`UPDATE "SalesOrder" SET "originalPromiseDate" = '2027-01-01' WHERE id = $1`, [order.id])).rejects.toThrow(/first promised date .* is set once/)
    order = { ...order, version: lineChanged.version }
  })
})

describe('production and shipping move the order (SAL-204: the system is their one writer)', () => {
  const so2 = () => seeded.a.quality.production.salesOrderId

  it('a released work order starts production, once; after the release the order is not cancelled', async () => {
    // SEED-SO-0003 (the quality seed's): WO-0003 released, nothing shipped yet.
    const so3 = seeded.a.quality.serialSalesOrderId
    const before = await one('SELECT version FROM "SalesOrder" WHERE id = $1', [so3])
    const cancel = await refused('a.sales', 'POST', `${orderUrl(so3)}/cancel`, { version: before.version, reason: 'The customer withdrew.' }, 409)
    expect(cancel.message).toMatch(/missing: no released work order/)
    const event = { workOrderId: seeded.a.quality.serialWorkOrderId, number: 'SEED-WO-0003', salesOrderIds: [so3] }
    for (let attempt = 1; attempt <= 2; attempt++) {
      await handler('sales.ordersFollowWorkOrders').handle(envelope('a', 'workorder.released', event), { caller: systemCaller('a'), attempt }) // a repeat changes nothing
    }
    expect(await statusOf(so3)).toBe('IN_PRODUCTION')
    const moves = (await auditsOf(so3)).filter((row) => row.action === 'orders.follow')
    expect(moves.map((row) => [row.before.status, row.after.status, row.reason, row.audience])).toEqual([['CONFIRMED', 'IN_PRODUCTION', 'Followed: work order SEED-WO-0003 released.', 'SYSTEM']])
    expect((await statusEvents(so3)).map((row) => row.payload)).toEqual([expect.objectContaining({ from: 'CONFIRMED', to: 'IN_PRODUCTION', by: 'system' })])
    await refused('a.sales', 'POST', `${orderUrl(so3)}/cancel`, { version: before.version + 1, reason: 'The customer withdrew.' }, 409)
  })

  it('ready by hand: IN_PRODUCTION → READY with a reason while quality release is not in use', async () => {
    const so3 = seeded.a.quality.serialSalesOrderId
    const { order: record } = await ok('a.sales', 'GET', orderUrl(so3))
    expect(record.actions.map((action: Json) => action.action)).toEqual(['changePromise', 'markReady'])
    await refused('a.sales', 'POST', `${orderUrl(so3)}/ready`, { version: record.version, reason: '' }, 400)
    await refused('a.viewer', 'POST', `${orderUrl(so3)}/ready`, { version: record.version, reason: 'Quality signed the paper sheet.' }, 403)
    const ready = (await ok('a.sales', 'POST', `${orderUrl(so3)}/ready`, { version: record.version, reason: 'Quality signed the paper sheet for all four.' })).order
    expect(ready).toMatchObject({ status: 'READY', version: record.version + 1 })
    // Quality released 2 of the 4 jackets: the person's reason carried the move, and the audit row says so.
    expect((await auditsOf(so3)).at(-1)).toMatchObject({ action: 'orders.markReady', audience: 'OFFICE', reason: 'Quality signed the paper sheet for all four.', before: { status: 'IN_PRODUCTION' }, after: { status: 'READY', releasedByQuality: false } })
    expect((await statusEvents(so3)).at(-1)!.payload).toMatchObject({ from: 'IN_PRODUCTION', to: 'READY', by: 'person' })
    await refused('a.sales', 'POST', `${orderUrl(so3)}/ready`, { version: ready.version, reason: 'Again.' }, 409)
  })

  it('SEED-SO-0002: cancel names the released and the draft work order; the release handler follows every fact at once', async () => {
    const before = await one('SELECT version FROM "SalesOrder" WHERE id = $1', [so2()])
    const cancel = await refused('a.sales', 'POST', `${orderUrl(so2())}/cancel`, { version: before.version, reason: 'The customer withdrew.' }, 409)
    expect(cancel.message).toMatch(/no released work order/)
    expect(cancel.message).toMatch(/draft work orders cancelled first \(SEED-WO-0002\)/)
    // WO-0001 released, and SH-0001 already left with 2 of the 7 jackets: production started, then part shipped.
    await released('a')
    expect((await auditsOf(so2())).filter((row) => row.action === 'orders.follow').map((row) => [row.before.status, row.after.status])).toEqual([
      ['CONFIRMED', 'IN_PRODUCTION'],
      ['IN_PRODUCTION', 'PARTLY_SHIPPED'],
    ])
  })

  it('part shipped → PARTLY_SHIPPED; the per-size progress counts work orders, quality releases and the shipment', async () => {
    const follows = (await auditsOf(so2())).length
    await shipped('a') // the shipment's own event: nothing more to follow
    expect(await statusOf(so2())).toBe('PARTLY_SHIPPED')
    expect((await auditsOf(so2())).length).toBe(follows)
    const { order: record } = await ok('a.sales', 'GET', orderUrl(so2()))
    const rows = record.lines.flatMap((line: Json) => line.sizes.map((size: Json) => [line.colourway.code, size.size, size.progress.ordered, size.progress.inWorkOrders, size.progress.released, size.progress.shipped, size.progress.toShip]))
    expect(rows).toEqual([
      // WO-0001 has every size; WO-0002 (a draft) one more BLK 52. Quality released BLK 50, BLK 52 ×2 less one taken back, RED 52.
      ['BLK', '50', 1, 1, 1, 1, 0],
      ['BLK', '52', 2, 3, 1, 0, 2],
      ['BLK', '54', 1, 1, 0, 0, 1],
      ['RED', '50', 1, 1, 0, 0, 1],
      ['RED', '52', 1, 1, 1, 1, 0],
      ['RED', '54', 1, 1, 0, 0, 1],
    ])
    expect(record.progress).toEqual({ ordered: 7, inWorkOrders: 8, made: null, released: 3, shipped: 2, invoiced: '0', toShip: 5 })
    expect(record.chain.workOrders.map((row: Json) => [row.number, row.status])).toEqual([['SEED-WO-0001', 'IN_PROGRESS'], ['SEED-WO-0002', 'DRAFT']])
    expect(record.chain.shipments.map((row: Json) => [row.number, row.status])).toEqual([['SEED-SH-0001', 'SHIPPED']])
    // Shipped in part: no ready by hand, no close, lines' promises are fixed; the order's own promise still moves.
    await refused('a.sales', 'POST', `${orderUrl(so2())}/ready`, { version: record.version, reason: 'Done.' }, 409)
    const close = await refused('a.finance', 'POST', `${orderUrl(so2())}/close`, { version: record.version, reason: 'Close it.' }, 409)
    expect(close.message).toMatch(/in PARTLY_SHIPPED cannot move to CLOSED/)
    const lines = await refused('a.sales', 'PUT', `${orderUrl(so2())}/promise`, { version: record.version, promiseDate: addDays(TODAY, 80), reason: 'Later.', lineIds: [record.lines[0].id] }, 409)
    expect(lines.message).toMatch(/lines are fixed once anything shipped/)
    await ok('a.sales', 'PUT', `${orderUrl(so2())}/promise`, { version: record.version, promiseDate: addDays(TODAY, 80), reason: 'The rest ships later.' })
  })

  it('a shipment move that ships nothing (packed, cancelled) is not followed: no command, no audit row', async () => {
    const before = (await auditsOf(so2())).length
    await shipped('a', 'CANCELLED')
    await shipped('a', 'PACKED')
    expect(await statusOf(so2())).toBe('PARTLY_SHIPPED')
    expect((await auditsOf(so2())).length).toBe(before)
  })

  it('shipped in full → SHIPPED in one command (production started first): two moves, two audit rows', async () => {
    const so = seeded.b.quality.production.salesOrderId
    await shipped('b')
    expect(await statusOf(so)).toBe('SHIPPED')
    expect((await auditsOf(so)).filter((row) => row.action === 'orders.follow').map((row) => [row.before.status, row.after.status])).toEqual([
      ['CONFIRMED', 'IN_PRODUCTION'],
      ['IN_PRODUCTION', 'SHIPPED'],
    ])
    const { order: record } = await ok('b.sales', 'GET', orderUrl(so))
    expect(record).toMatchObject({ status: 'SHIPPED', daysLate: null, progress: { ordered: 2, shipped: 2, toShip: 0 }, actions: [{ action: 'changePromise' }, { action: 'close', allowed: true, needsReason: true }] })
  })
})

describe('closing (PLAN §4.7: the close command asks whether every line is shipped, invoiced and paid)', () => {
  it('not settled: refused without a reason, forbidden with one for a person without orders.close, closed by one with it', async () => {
    const so = seeded.b.quality.production.salesOrderId
    const { order: record } = await ok('b.sales', 'GET', orderUrl(so))
    const noReason = await refused('b.finance', 'POST', `${orderUrl(so)}/close`, { version: record.version }, 409)
    // The money module's answer, in its words: shipped in full, not invoiced.
    expect(record.settlement).toMatchObject({ settled: false, source: 'invoicing' })
    const codes = record.settlement.missing.map((gap: Json) => gap.code)
    expect(codes).toEqual(expect.arrayContaining(['NOT_INVOICED', 'NO_INVOICE']))
    expect(codes).not.toContain('NOT_SHIPPED')
    expect(noReason.message).toMatch(/missing: every line shipped, invoiced and paid \(Shipped, not invoiced: .*\), or a reason to close it anyway/)
    await refused('b.sales', 'POST', `${orderUrl(so)}/close`, { version: record.version, reason: 'Small balance written off.' }, 403)
    expect(await statusOf(so)).toBe('SHIPPED')
    const closed = (await ok('b.finance', 'POST', `${orderUrl(so)}/close`, { version: record.version, reason: 'Small balance written off.' })).order
    expect(closed).toMatchObject({ status: 'CLOSED', actions: [] })
    expect(closed.closedAt).not.toBeNull()
    const row = (await auditsOf(so)).find((entry) => entry.action === 'orders.close')!
    expect(row).toMatchObject({ reason: 'Small balance written off.', before: { status: 'SHIPPED' }, after: { status: 'CLOSED', settled: false, missing: codes, settlementSource: 'invoicing' } })
    // CLOSED is final: no promise change, and the database refuses any write for every login.
    await refused('b.sales', 'PUT', `${orderUrl(so)}/promise`, { version: closed.version, promiseDate: addDays(TODAY, 10), reason: 'Again.' }, 409)
    await refused('b.finance', 'POST', `${orderUrl(so)}/close`, { version: closed.version, reason: 'Again.' }, 409)
    await expect(admin(`UPDATE "SalesOrder" SET priority = 3 WHERE id = $1`, [so])).rejects.toThrow(/is CLOSED; it never changes/)
  })

  it('the settle event is only the trigger: the system closes what the port calls settled, and only that', async () => {
    const so = seeded.c.quality.production.salesOrderId
    await shipped('c')
    expect(await statusOf(so)).toBe('SHIPPED')
    // An event whose settlement the money module no longer confirms (read again under the order's lock): nothing moves.
    await settledEvent('c', so)
    expect(await statusOf(so)).toBe('SHIPPED')
    expect((await auditsOf(so)).filter((row) => row.action === 'orders.follow').map((row) => row.after.status)).toEqual(['IN_PRODUCTION', 'SHIPPED'])
    settledForTest([so])
    try {
      await settledEvent('c', so)
    } finally {
      useOrderSettlement(undefined)
    }
    expect(await statusOf(so)).toBe('CLOSED')
    const close = (await auditsOf(so)).filter((row) => row.action === 'orders.follow').at(-1)!
    expect(close).toMatchObject({ audience: 'SYSTEM', reason: 'Followed: the order is settled.', before: { status: 'SHIPPED' }, after: { status: 'CLOSED', settled: true, settlementSource: 'test' } })
    expect((await statusEvents(so)).at(-1)!.payload).toMatchObject({ from: 'SHIPPED', to: 'CLOSED', by: 'system' })
    await settledEvent('c', so) // a repeat: nothing more
    expect((await auditsOf(so)).filter((row) => row.action === 'orders.follow')).toHaveLength(3)
  })

  it('settled: a person with orders.manage closes it without a reason', async () => {
    const so = seeded.d.quality.production.salesOrderId
    await shipped('d')
    settledForTest([so])
    try {
      const { order: record } = await ok('d.sales', 'GET', orderUrl(so))
      expect(record.actions.find((action: Json) => action.action === 'close')).toEqual({ action: 'close', allowed: true, needsReason: false, held: null })
      const closed = (await ok('d.sales', 'POST', `${orderUrl(so)}/close`, { version: record.version })).order
      expect(closed.status).toBe('CLOSED')
    } finally {
      useOrderSettlement(undefined)
    }
    expect((await auditsOf(so)).find((row) => row.action === 'orders.close')).toMatchObject({ reason: null, after: { settled: true, missing: [], settlementSource: 'test' } })
  })
})

describe('cancel (a reason, only before any work order is released)', () => {
  it('cancels a CONFIRMED order with its OPEN deposit request; a cancelled order never changes', async () => {
    const { order: before } = await ok('a.sales', 'GET', orderUrl(waitingOrderId))
    await refused('a.sales', 'POST', `${orderUrl(waitingOrderId)}/cancel`, { version: before.version, reason: '' }, 400)
    const answer = await ok('a.sales', 'POST', `${orderUrl(waitingOrderId)}/cancel`, { version: before.version, reason: 'The customer withdrew before production.' })
    expect(answer).toMatchObject({ order: { status: 'CANCELLED', cancelReason: 'The customer withdrew before production.', actions: [] }, paidDepositRequestIds: [] })
    expect(answer.order.chain.depositRequests.map((row: Json) => row.status)).toEqual(['CANCELLED'])
    expect((await one('SELECT "statusNote" FROM "DepositRequest" WHERE "orderId" = $1', [waitingOrderId])).statusNote).toBe(`Order SO-${YEAR}-0001 cancelled: The customer withdrew before production.`)
    await refused('a.sales', 'POST', `${orderUrl(waitingOrderId)}/cancel`, { version: answer.order.version, reason: 'Again.' }, 409)
    await refused('a.sales', 'PUT', `${orderUrl(waitingOrderId)}/promise`, { version: answer.order.version, promiseDate: addDays(TODAY, 10), reason: 'Again.' }, 409)
  })
})

describe('the list, the board and the tiles (SAL-214: counts that match the list)', () => {
  it('each tile and state count is the list total under the same filter', async () => {
    // SEED-SO-0001 (the sales seed's) promised in the past: late.
    await admin(`UPDATE "SalesOrder" SET "promiseDate" = '2026-01-10' WHERE number = 'SEED-SO-0001' AND "tenantId" = $1`, [T.a])
    const board = await ok('a.sales', 'GET', '/sales/orders/board')
    expect(board.lanes).toEqual(['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'])
    const total = (await ok('a.sales', 'GET', '/sales/orders?limit=200')).orders.length
    expect(board.byStatus.reduce((sum: number, row: Json) => sum + row.count, 0)).toBe(total)
    for (const row of board.byStatus) expect((await ok('a.sales', 'GET', `/sales/orders?status=${row.status}&limit=200`)).orders.length, row.status).toBe(row.count)
    for (const tile of board.tiles) {
      const query = new URLSearchParams({ ...tile.filter, limit: '200' }).toString()
      expect((await ok('a.sales', 'GET', `/sales/orders?${query}`)).orders.length, tile.key).toBe(tile.count)
    }
    expect(board.byStatus.find((row: Json) => row.status === 'PARTLY_SHIPPED').count).toBe(1)
    const late = (await ok('a.sales', 'GET', '/sales/orders?late=true')).orders
    expect(late.map((row: Json) => [row.number, row.daysLate > 0])).toEqual([['SEED-SO-0001', true]])
    const waitingDeposit = (await ok('a.sales', 'GET', '/sales/orders?deposit=OPEN&limit=200')).orders.map((row: Json) => row.number)
    expect(waitingDeposit).toContain(order.number)
    expect(waitingDeposit).not.toContain(`SO-${YEAR}-0001`) // cancelled with its deposit
    const row = (await ok('a.sales', 'GET', `/sales/orders?q=${order.number}`)).orders
    expect(row).toEqual([expect.objectContaining({ number: order.number, partyId: P1, status: 'CONFIRMED', units: 14, shippedUnits: 0, lineCount: 2, netAmount: 624000, deposit: { state: 'OPEN', dueDate: expect.any(String) }, quote: expect.objectContaining({ id: accepted.quoteId }) })])
    const shippedRow = (await ok('a.sales', 'GET', '/sales/orders?status=PARTLY_SHIPPED')).orders[0]
    expect(shippedRow).toMatchObject({ number: 'SEED-SO-0002', units: 7, shippedUnits: 2 })
  })
})

describe('walls: tenant, company, party, money; the floor and the portal are refused', () => {
  it('another tenant, another company, another party: not found and an empty list', async () => {
    await refused('b.sales', 'GET', orderUrl(order.id), undefined, 404)
    expect((await ok('b.sales', 'GET', `/sales/orders?q=${order.number}`)).orders).toEqual([])
    await refused('a.companyB', 'GET', orderUrl(order.id), undefined, 404)
    expect((await ok('a.companyB', 'GET', '/sales/orders')).orders).toEqual([])
    expect((await ok('a.companyB', 'GET', '/sales/orders/board')).byStatus.every((row: Json) => row.count === 0)).toBe(true)
    await refused('a.otherParty', 'GET', orderUrl(order.id), undefined, 404)
    await refused('a.otherParty', 'PUT', `${orderUrl(order.id)}/promise`, { version: order.version, promiseDate: addDays(TODAY, 100), reason: 'x' }, 404)
    await refused('a.companyB', 'POST', '/sales/orders', { quoteVersionId: accepted.versionId }, 404)
  })

  it('without the right: a viewer reads but changes nothing; no orders permission is a 403; money only with its grain', async () => {
    const { order: seen } = await ok('a.viewer', 'GET', orderUrl(order.id))
    expect(seen).not.toHaveProperty('netAmount')
    expect(seen.lines[0]).not.toHaveProperty('unitPrice')
    expect(seen.lines[0].sizes[0]).not.toHaveProperty('unitPrice')
    await refused('a.viewer', 'PUT', `${orderUrl(order.id)}/promise`, { version: order.version, promiseDate: addDays(TODAY, 100), reason: 'x' }, 403)
    await refused('a.viewer', 'POST', `${orderUrl(order.id)}/close`, { version: order.version, reason: 'x' }, 403)
    await refused('a.noOrders', 'GET', '/sales/orders', undefined, 403)
    const { order: costed } = await ok('a.sales', 'GET', orderUrl(order.id))
    expect(costed.costAmount).toBe(order.costAmount)
  })

  it('the floor and a portal session are refused by audience', async () => {
    for (const session of ['a.floor', 'a.partner']) {
      await refused(session, 'GET', '/sales/orders', undefined, 403)
      await refused(session, 'GET', orderUrl(order.id), undefined, 403)
      await refused(session, 'POST', `${orderUrl(order.id)}/close`, { version: order.version, reason: 'x' }, 403)
    }
  })
})
