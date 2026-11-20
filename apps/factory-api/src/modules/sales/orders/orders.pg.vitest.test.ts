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
// B-SA-034: the order read's live watch list is made of declared events only.
import { EVENT_CATALOGUE } from '@nexus/factory-domain/events/catalogue'
// B-SA-035: the lines' pictures and artwork are files of the style, its colourway and the line.
import { seedFile } from '../../../../../../packages/factory-db/src/seed-files'
// B-OP-020: the orders, credit and changes seed (SEED-SO-W39-01 waiting, SEED-SO-W39-02's old request for a yes), and a request asked
// through the approval engine as the order's making asks it.
import { APPROVAL_REFUSALS } from '@nexus/factory-domain/approvals/rules'
import { seed as seedAccounting } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedSalesOrdersDepth, type SalesOrdersDepthSeed } from '../../../../../../packages/factory-db/seed/sales-orders-depth'
import { command } from '../../../core/command'
import { askApproval } from '../../../platform/approvals/engine'

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
// B-CP-011 (the money wall): the quotes' prices are the Owner's (and the people he names); Sales sees no money.
let owner: Browser

// F-SA-201: tenant e's SEED-SO-0002 ships in full and is delivered, then closed.
// B-OO-001: tenant g's SEED-SO-0003 and SEED-SO-0002 follow quality's releases and reversals ('orders-f' is B-OP-020's own).
const NS = { a: 'orders-a', b: 'orders-b', c: 'orders-c', d: 'orders-d', e: 'orders-e', g: 'orders-g' } as const
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
  // F-SA-201: a person of tenant e limited to another customer (Brand Beta's people), with every right to close.
  'e.otherParty': office('e', [...MANAGE, 'orders.close'], 'all', [idIn('e', 'party:P3')]),
  'a.floor': () => ({ audience: 'floor', tenantId: T.a, actorId: newId(), siteId: siteA, deviceId: newId(), grants: [{ permissions: ['floor.work', ...MANAGE], companies: [companyA], sites: [siteA], parties: 'all' }] }),
  'a.partner': () => ({ audience: 'partner', tenantId: T.a, actorId: newId(), partyId: P1, grants: [{ permissions: MANAGE, companies: 'all', sites: 'all', parties: [P1] }] }),
  // B-SA-034: the order page's readers of production (work orders), every customer and P1 only.
  'a.production': office('a', ['orders.view', 'workorders.view']),
  'a.production.p1': office('a', ['orders.view', 'workorders.view'], 'all', [P1]),
  // B-SA-035: the order page's readers of the lines' pictures and artwork — with files.read, and with files.read of another company only.
  'a.files': office('a', ['orders.view', 'files.read']),
  'a.files.companyB': () => ({ audience: 'office', tenantId: T.a, actorId: newId(), grants: [grant(['orders.view']), grant(['files.read'], [companyB])] }),
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
// B-CP-011: made, priced and sent by the Owner (a Sales worker may not send unitPrice any more).
async function acceptedQuote(): Promise<{ quoteId: string; versionId: string; number: string }> {
  let quote = (await as(owner, 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-0077', promiseDate: PROMISE }, 201)).quote
  quote = (await as(owner, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jacket, colourwayId: BLK, sizes: BLK_GRID, unitPrice: '450' }, 201)).quote
  quote = (await as(owner, 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: jacket, colourwayId: RED, sizes: RED_GRID, unitPrice: '440' }, 201)).quote
  const before = h.ses.mails.length
  const sent = await as(owner, 'POST', `/sales/quotes/${quote.id}/send`, { version: quote.version }, 200, { 'idempotency-key': key('send') })
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
  // Company A's letterhead (its quote series is the numbering seed's; its seeded SALES_ORDER series is closed for the
  // first acceptance), a FAKE file store and a FAKE mail account with a verified conversation address.
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
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
  // B-CP-011: the Owner, signed in for real as Sales is: the one who prices the quotes (the price grain is his).
  const ownerUser = await addUser(h, tenantA, { email: 'oscar.owner@seed-a.example.com', role: 'owner' })
  // The order screens' reads (SCR-039): a session acting as that real person, so the record can name them.
  // B-CP-011: the margin % reader is the Owner now (Sales holds no margin grain).
  SESSIONS['a.named'] = () => ({ audience: 'office', tenantId: T.a, actorId: ownerUser.id, grants: [grant(['orders.view', 'orders.manage', 'money.price', 'money.margin'])] })
  sales = new Browser(h.app)
  expect((await sales.signIn(NS.a, salesUser.email, salesUser.password)).status).toBe(200)
  await enrolTotp(h, sales)
  owner = new Browser(h.app)
  expect((await owner.signIn(NS.a, ownerUser.email, ownerUser.password)).status).toBe(200)
  await enrolTotp(h, owner)
  for (const tenant of ['b', 'c', 'd', 'e'] as const) await cutDownToShipped(tenant) // F-SA-201: and e
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
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

  // B-CP-011: the priced record is the Owner's; the Sales worker reads the same record without money (below).
  it('the record (the owner, signed in): lines with size grids and per-size progress, the chain, the settlement, what comes next', async () => {
    const { order: record } = await as(owner, 'GET', orderUrl(order.id))
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
    // B-CP-011 (was: the sales template sees prices, not costs): the Sales worker sees the same record with no money at all.
    const { order: bySales } = await as(sales, 'GET', orderUrl(order.id))
    expect(bySales).toMatchObject({ id: order.id, number: order.number, status: 'CONFIRMED', promiseDate: PROMISE, progress: { ordered: 14, toShip: 14 } })
    for (const field of ['netAmount', 'grossAmount', 'costAmount', 'marginPct']) expect(bySales).not.toHaveProperty(field)
    expect(bySales.lines.map((line: Json) => [line.seq, line.colourway.code])).toEqual([[10, 'BLK'], [20, 'RED']])
    for (const field of ['unitPrice', 'unitCost']) expect(bySales.lines[0]).not.toHaveProperty(field)
    expect(bySales.chain.depositRequests[0]).not.toHaveProperty('amount')
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

  // ── B-OO-009 (order overview N10): the promise reason as a field — a curated code the customer reads, and/or the office's note ──
  it('B-OO-009: a reason code with or without a note is stored as CODE: note; neither, or an unknown code, is a 400', async () => {
    const url = `${orderUrl(order.id)}/promise`
    const later = addDays(TODAY, 100)
    const neither = await refused('a.sales', 'PUT', url, { version: order.version, promiseDate: later }, 400)
    expect(neither.issues.map((issue: Json) => issue.path)).toContain('body/reason')
    expect((await refused('a.sales', 'PUT', url, { version: order.version, promiseDate: later, reason: '   ' }, 400)).issues.map((issue: Json) => issue.path)).toContain('body/reason')
    const unknown = await refused('a.sales', 'PUT', url, { version: order.version, promiseDate: later, reasonCode: 'WEATHER', reason: 'Snow on the pass.' }, 400)
    expect(unknown.issues.map((issue: Json) => issue.path)).toContain('body/reasonCode')
    const coded = (await ok('a.sales', 'PUT', url, { version: order.version, promiseDate: later, reasonCode: 'CAPACITY', reason: '  Line 2 is down for a week.  ' })).order
    expect(coded.promiseHistory[0]).toMatchObject({ to: later, lineIds: [], reason: 'CAPACITY: Line 2 is down for a week.' })
    // A code alone (the note left empty): the code is the reason.
    const alone = (await ok('a.sales', 'PUT', url, { version: coded.version, promiseDate: addDays(TODAY, 101), reasonCode: 'TRANSPORT', reason: '' })).order
    expect(alone.promiseHistory[0]).toMatchObject({ to: addDays(TODAY, 101), reason: 'TRANSPORT' })
    const stored = await admin<{ reason: string }>(`SELECT reason FROM "AuditLog" WHERE action = 'orders.changePromise' AND "recordId" = $1 ORDER BY at DESC, id DESC LIMIT 2`, [order.id])
    expect(stored.map((row) => row.reason)).toEqual(['TRANSPORT', 'CAPACITY: Line 2 is down for a week.'])
    order = { ...order, version: alone.version }
  })
  // ── end B-OO-009 ──
})

describe('production and shipping move the order (SAL-204: the system is their one writer)', () => {
  const so2 = () => seeded.a.quality.production.salesOrderId

  it('a released work order starts production, once; the cancel check then names it as left behind (B-W2a-30)', async () => {
    // SEED-SO-0003 (the quality seed's): WO-0003 released, nothing shipped yet.
    const so3 = seeded.a.quality.serialSalesOrderId
    const before = await one('SELECT version FROM "SalesOrder" WHERE id = $1', [so3])
    // W2a (SAL-211): a released work order no longer stops a cancellation, the impact check names it; SH-0002, being
    // packed for it, does (the warehouse cancels it first).
    const check = await ok('a.sales', 'GET', `${orderUrl(so3)}/cancel-check`)
    expect(check.impact.cancellable).toBe(false)
    expect(check.impact.blocks.map((item: Json) => [item.code, item.refs.map((ref: Json) => ref.number)])).toEqual([['SHIPMENT_IN_PREPARATION', ['SEED-SH-0002']]])
    expect(check.impact.leavesBehind.find((item: Json) => item.code === 'WORK_ORDERS_OPEN')?.refs.map((ref: Json) => ref.number)).toEqual(['SEED-WO-0003'])
    const event = { workOrderId: seeded.a.quality.serialWorkOrderId, number: 'SEED-WO-0003', salesOrderIds: [so3] }
    for (let attempt = 1; attempt <= 2; attempt++) {
      await handler('sales.ordersFollowWorkOrders').handle(envelope('a', 'workorder.released', event), { caller: systemCaller('a'), attempt }) // a repeat changes nothing
    }
    expect(await statusOf(so3)).toBe('IN_PRODUCTION')
    const moves = (await auditsOf(so3)).filter((row) => row.action === 'orders.follow')
    expect(moves.map((row) => [row.before.status, row.after.status, row.reason, row.audience])).toEqual([['CONFIRMED', 'IN_PRODUCTION', 'Followed: work order SEED-WO-0003 released.', 'SYSTEM']])
    expect((await statusEvents(so3)).map((row) => row.payload)).toEqual([expect.objectContaining({ from: 'CONFIRMED', to: 'IN_PRODUCTION', by: 'system' })])
    // A stale version is still a 409; the order stays IN_PRODUCTION for the tests that follow.
    await refused('a.sales', 'POST', `${orderUrl(so3)}/cancel`, { version: before.version, reason: 'The customer withdrew.' }, 409)
  })

  it('ready by hand: IN_PRODUCTION → READY with a reason while quality release is not in use', async () => {
    const so3 = seeded.a.quality.serialSalesOrderId
    const { order: record } = await ok('a.sales', 'GET', orderUrl(so3))
    // B-W2a-30: cancel is offered while IN_PRODUCTION too, held here by SH-0002 being packed for it.
    expect(record.actions.map((action: Json) => action.action)).toEqual(['changePromise', 'markReady', 'cancel'])
    expect(record.actions[2]).toMatchObject({ allowed: false, held: expect.stringMatching(/SEED-SH-0002/) })
    await refused('a.sales', 'POST', `${orderUrl(so3)}/ready`, { version: record.version, reason: '' }, 400)
    await refused('a.viewer', 'POST', `${orderUrl(so3)}/ready`, { version: record.version, reason: 'Quality signed the paper sheet.' }, 403)
    const ready = (await ok('a.sales', 'POST', `${orderUrl(so3)}/ready`, { version: record.version, reason: 'Quality signed the paper sheet for all four.' })).order
    expect(ready).toMatchObject({ status: 'READY', version: record.version + 1 })
    // Quality released 2 of the 4 jackets: the person's reason carried the move, and the audit row says so.
    expect((await auditsOf(so3)).at(-1)).toMatchObject({ action: 'orders.markReady', audience: 'OFFICE', reason: 'Quality signed the paper sheet for all four.', before: { status: 'IN_PRODUCTION' }, after: { status: 'READY', releasedByQuality: false } })
    expect((await statusEvents(so3)).at(-1)!.payload).toMatchObject({ from: 'IN_PRODUCTION', to: 'READY', by: 'person' })
    await refused('a.sales', 'POST', `${orderUrl(so3)}/ready`, { version: ready.version, reason: 'Again.' }, 409)
  })

  it('SEED-SO-0002: cancel names the draft work order and what cannot be undone; the release handler follows every fact at once', async () => {
    const before = await one('SELECT version FROM "SalesOrder" WHERE id = $1', [so2()])
    const cancel = await refused('a.sales', 'POST', `${orderUrl(so2())}/cancel`, { version: before.version, reason: 'The customer withdrew.' }, 409)
    expect(cancel.message).toMatch(/draft work orders cancelled first \(SEED-WO-0002\)/)
    // B-W2a-30: SH-0001 already left with 2 jackets: a shipped order is not cancelled.
    expect(cancel.message).toMatch(/Goods left with SEED-SH-0001/)
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
    expect(record.progress).toEqual({ ordered: 7, inWorkOrders: 8, made: null, released: 3, shipped: 2, invoiced: '0', toShip: 5, closedShort: 0 })
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

// ── B-OO-001 (order overview N4, Owner D2): the order follows quality; back to IN_PRODUCTION only on a reversal ──────────────
describe('the order follows quality (B-OO-001): READY after the last release, back only on a reversal, skipped once anything shipped', () => {
  const so3 = () => seeded.g.quality.serialSalesOrderId
  const followQuality = (type: 'quality.garments_released' | 'quality.release_reversed', cellId: string, number: string, attempts = 1) =>
    (async () => {
      const event = envelope('g', type, { workOrderSizeId: cellId, number, quantity: 1 })
      for (let attempt = 1; attempt <= attempts; attempt++) await handler('sales.ordersFollowQuality').handle(event, { caller: systemCaller('g'), attempt })
    })()
  const workOrderReleased = () =>
    handler('sales.ordersFollowWorkOrders').handle(envelope('g', 'workorder.released', { workOrderId: seeded.g.quality.serialWorkOrderId, number: 'SEED-WO-0003', salesOrderIds: [so3()] }), { caller: systemCaller('g'), attempt: 1 })
  const follows = async (orderId: string) => (await auditsOf(orderId)).filter((row) => row.action === 'orders.follow').map((row) => [row.before.status, row.after.status, row.reason])
  /** Tenant g's SEED-SO-0003 asks `pieces` × BLK 52 (WO-0003 makes 4; quality released 2 of them, the quality seed). */
  const orderPieces = async (pieces: number) => {
    await admin('UPDATE "SalesOrderLineSize" s SET quantity = $2 FROM "SalesOrderLine" l WHERE s."lineId" = l.id AND l."orderId" = $1', [so3(), pieces])
    await admin('UPDATE "SalesOrderLine" SET quantity = $2 WHERE "orderId" = $1', [so3(), pieces])
  }

  it('a release while pieces are still to release moves nothing; the last one makes it READY once (a replay: no second command or audit row)', async () => {
    await workOrderReleased()
    expect(await statusOf(so3())).toBe('IN_PRODUCTION')
    const before = (await auditsOf(so3())).length
    // 2 of the 4 released: nothing to follow, no command.
    await followQuality('quality.garments_released', seeded.g.quality.serialCellId, 'SEED-WO-0003')
    expect([await statusOf(so3()), (await auditsOf(so3())).length]).toEqual(['IN_PRODUCTION', before])
    // The order now asks the 2 quality released: the release's handler moves it, once.
    await orderPieces(2)
    await followQuality('quality.garments_released', seeded.g.quality.serialCellId, 'SEED-WO-0003', 2)
    expect(await statusOf(so3())).toBe('READY')
    expect(await follows(so3())).toEqual([
      ['CONFIRMED', 'IN_PRODUCTION', 'Followed: work order SEED-WO-0003 released.'],
      ['IN_PRODUCTION', 'READY', 'Followed: quality released 1 garment(s) of SEED-WO-0003.'],
    ])
    expect((await statusEvents(so3())).map((row) => [row.payload.from, row.payload.to, row.payload.by])).toEqual([
      ['CONFIRMED', 'IN_PRODUCTION', 'system'],
      ['IN_PRODUCTION', 'READY', 'system'],
    ])
    expect((await auditsOf(so3())).filter((row) => row.action === 'orders.follow').map((row) => row.audience)).toEqual(['SYSTEM', 'SYSTEM'])
  })

  it('a later release or a work order released never moves a READY order back, even with a piece left to release', async () => {
    // One more piece asked than quality released (the facts a taken-back release leaves; the reversal row is quality's own).
    await orderPieces(3)
    const before = (await auditsOf(so3())).length
    await followQuality('quality.garments_released', seeded.g.quality.serialCellId, 'SEED-WO-0003')
    await workOrderReleased()
    expect([await statusOf(so3()), (await auditsOf(so3())).length]).toEqual(['READY', before])
  })

  it('a release taken back moves it back to IN_PRODUCTION (the system, once); with every piece still released it stays READY', async () => {
    await followQuality('quality.release_reversed', seeded.g.quality.serialCellId, 'SEED-WO-0003', 2)
    expect(await statusOf(so3())).toBe('IN_PRODUCTION')
    expect((await follows(so3())).at(-1)).toEqual(['READY', 'IN_PRODUCTION', 'Followed: a quality release of SEED-WO-0003 was taken back.'])
    expect((await statusEvents(so3())).at(-1)!.payload).toMatchObject({ from: 'READY', to: 'IN_PRODUCTION', by: 'system', partyId: idIn('g', 'party:P1') })
    expect((await follows(so3())).filter(([from, to]) => from === 'READY' && to === 'IN_PRODUCTION')).toHaveLength(1)
    // Back to 2: READY again; a reversal event while every piece is still released moves nothing.
    await orderPieces(2)
    await followQuality('quality.garments_released', seeded.g.quality.serialCellId, 'SEED-WO-0003')
    expect(await statusOf(so3())).toBe('READY')
    const before = (await auditsOf(so3())).length
    await followQuality('quality.release_reversed', seeded.g.quality.serialCellId, 'SEED-WO-0003')
    expect([await statusOf(so3()), (await auditsOf(so3())).length]).toEqual(['READY', before])
  })

  it('a piece shipped before the last release: never READY (part shipped instead), and a reversal never moves it back', async () => {
    // Tenant g's SEED-SO-0002 cut down to what quality released (BLK 50, one BLK 52, RED 52); SH-0001 already left with 2 of them.
    const so2 = seeded.g.quality.production.salesOrderId
    await admin(
      `DELETE FROM "SalesOrderLineSize" s USING "SalesOrderLine" l, "Colourway" c
        WHERE s."lineId" = l.id AND c.id = l."colourwayId" AND l."orderId" = $1 AND NOT ((c.code = 'BLK' AND s.size IN ('50', '52')) OR (c.code = 'RED' AND s.size = '52'))`,
      [so2],
    )
    await admin(`UPDATE "SalesOrderLineSize" s SET quantity = 1 FROM "SalesOrderLine" l WHERE s."lineId" = l.id AND l."orderId" = $1`, [so2])
    await admin(`UPDATE "SalesOrderLine" l SET quantity = (SELECT sum(s.quantity) FROM "SalesOrderLineSize" s WHERE s."lineId" = l.id) WHERE l."orderId" = $1`, [so2])
    const blk52 = seeded.g.quality.production.cellIds['BLK-52']
    await followQuality('quality.garments_released', blk52, 'SEED-WO-0001')
    expect(await follows(so2)).toEqual([
      ['CONFIRMED', 'IN_PRODUCTION', 'Followed: quality released 1 garment(s) of SEED-WO-0001.'],
      ['IN_PRODUCTION', 'PARTLY_SHIPPED', 'Followed: quality released 1 garment(s) of SEED-WO-0001.'],
    ])
    const before = (await auditsOf(so2)).length
    await followQuality('quality.release_reversed', blk52, 'SEED-WO-0001')
    expect([await statusOf(so2), (await auditsOf(so2)).length]).toEqual(['PARTLY_SHIPPED', before])
  })
})
// ── end B-OO-001 ──

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

// ---- F-SA-201 (P22): a delivered order is closed as a shipped one is ------------------------------------------------------
describe('closing a delivered order (F-SA-201: DELIVERED → CLOSED; the record offers Close order)', () => {
  it('delivered: Close order is offered; another customer’s person gets the words of an unknown order; not settled needs a reason and orders.close; settled closes', async () => {
    const so = seeded.e.quality.production.salesOrderId
    await shipped('e')
    expect(await statusOf(so)).toBe('SHIPPED')
    // The carrier delivered SH-0001 (the shipment's own move), then the follow handler moves the order.
    await admin(`UPDATE "Shipment" SET status = 'DELIVERED', "deliveredAt" = now() - interval '1 hour' WHERE id = $1`, [seeded.e.shipmentId])
    await shipped('e', 'DELIVERED')
    expect(await statusOf(so)).toBe('DELIVERED')
    const { order: record } = await ok('e.sales', 'GET', orderUrl(so))
    expect(record).toMatchObject({ status: 'DELIVERED', actions: [{ action: 'changePromise' }, { action: 'close', allowed: true, needsReason: true }] })
    // The brand wall: a person limited to another customer gets exactly the answer of an unknown order, and nothing moves.
    const unknown = await refused('e.otherParty', 'POST', `${orderUrl(newId())}/close`, { version: record.version, reason: 'Close it.' }, 404)
    const walled = await refused('e.otherParty', 'POST', `${orderUrl(so)}/close`, { version: record.version, reason: 'Close it.' }, 404)
    expect({ code: walled.code, message: walled.message }).toEqual({ code: unknown.code, message: unknown.message })
    expect(walled.message).toBe('Sales order not found.')
    // Not settled: a reason (409 with what is missing), and the right to close unsettled orders (403 without it).
    const noReason = await refused('e.finance', 'POST', `${orderUrl(so)}/close`, { version: record.version }, 409)
    expect(noReason.message).toMatch(/or a reason to close it anyway/)
    await refused('e.sales', 'POST', `${orderUrl(so)}/close`, { version: record.version, reason: 'Small balance written off.' }, 403)
    expect(await statusOf(so)).toBe('DELIVERED')
    expect((await auditsOf(so)).filter((row) => row.action === 'orders.close')).toEqual([])
    // Settled: orders.manage closes it without a reason; the delivered time stays.
    settledForTest([so])
    try {
      const { order: settledRecord } = await ok('e.sales', 'GET', orderUrl(so))
      expect(settledRecord.actions.find((action: Json) => action.action === 'close')).toEqual({ action: 'close', allowed: true, needsReason: false, held: null })
      const closed = (await ok('e.sales', 'POST', `${orderUrl(so)}/close`, { version: settledRecord.version })).order
      expect(closed).toMatchObject({ status: 'CLOSED', actions: [] })
    } finally {
      useOrderSettlement(undefined)
    }
    expect((await auditsOf(so)).find((row) => row.action === 'orders.close')).toMatchObject({ reason: null, before: { status: 'DELIVERED' }, after: { status: 'CLOSED', settled: true, missing: [], settlementSource: 'test' } })
    expect((await one<{ deliveredAt: Date | null }>('SELECT "deliveredAt" FROM "SalesOrder" WHERE id = $1', [so])).deliveredAt).not.toBeNull()
    expect((await statusEvents(so)).at(-1)!.payload).toMatchObject({ from: 'DELIVERED', to: 'CLOSED', by: 'person' })
  })
})
// ---- end F-SA-201

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

// ---- B-SA-070b (sales page plan R7; #1652's own numbers): the office order read and its Orders row carry the customer's own number,
// so the Discuss chip and Reply to N's preview read "Your order 12" (the portal's count), never the office series.
describe('B-SA-070b: the order and its row carry the customer\'s own number (the database gives it)', () => {
  it('the record and the Orders row name the same customerSeq as the database', async () => {
    const [own] = await admin<{ id: string; customerSeq: number | null }>(`SELECT id::text AS id, "customerSeq" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [T.a])
    expect(own!.customerSeq).toEqual(expect.any(Number))
    const { order: record } = await ok('a.sales', 'GET', orderUrl(own!.id))
    expect(record.customerSeq).toBe(own!.customerSeq)
    const list = await ok('a.sales', 'GET', `/sales/orders?ids=${own!.id}`)
    expect(list.orders).toEqual([expect.objectContaining({ id: own!.id, customerSeq: own!.customerSeq })])
    // Every row says it (null only for a row made before the number was given).
    for (const row of (await ok('a.sales', 'GET', '/sales/orders?limit=200')).orders) expect(row).toHaveProperty('customerSeq')
  })
})
// ---- end B-SA-070b

describe('the list, the board and the tiles (SAL-214: counts that match the list)', () => {
  it('each tile and state count is the list total under the same filter', async () => {
    // SEED-SO-0001 (the sales seed's) promised in the past: late.
    await admin(`UPDATE "SalesOrder" SET "promiseDate" = '2026-01-10' WHERE number = 'SEED-SO-0001' AND "tenantId" = $1`, [T.a])
    const board = await ok('a.sales', 'GET', '/sales/orders/board')
    // B-SA-012 (sales page plan N8, P12): the board's first lane is Waiting for a yes (PENDING_APPROVAL).
    expect(board.lanes).toEqual(['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED', 'SHIPPED'])
    const total = (await ok('a.sales', 'GET', '/sales/orders?limit=200')).orders.length
    expect(board.byStatus.reduce((sum: number, row: Json) => sum + row.count, 0)).toBe(total)
    for (const row of board.byStatus) expect((await ok('a.sales', 'GET', `/sales/orders?status=${row.status}&limit=200`)).orders.length, row.status).toBe(row.count)
    for (const tile of board.tiles) {
      const query = new URLSearchParams({ ...tile.filter, limit: '200' }).toString()
      expect((await ok('a.sales', 'GET', `/sales/orders?${query}`)).orders.length, tile.key).toBe(tile.count)
    }
    expect(board.byStatus.find((row: Json) => row.status === 'PARTLY_SHIPPED').count).toBe(1)
    const late = (await ok('a.sales', 'GET', '/sales/orders?late=true')).orders
    // ---- B-W2b-F43: late = the open orders promised before today, read from the database, so the list holds on every day (it was
    // SEED-SO-0001 alone, which failed once SEED-SO-0003's seeded promise, 11 Dec 2026, had passed).
    const promisedBefore = await admin<{ number: string }>(
      `SELECT number FROM "SalesOrder" WHERE "tenantId" = $1 AND status::text IN ('CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED') AND "promiseDate" < $2::date ORDER BY number`,
      [T.a, TODAY],
    )
    expect(promisedBefore.map((row) => row.number)).toContain('SEED-SO-0001')
    expect(late.map((row: Json) => [row.number, row.daysLate > 0]).sort()).toEqual(promisedBefore.map((row) => [row.number, true]))
    // ---- end B-W2b-F43
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

describe('what the order screens read (SCR-039): the deposit as paid and sent, the TD02 it bills, margin %, names', () => {
  let finance: Browser
  beforeAll(async () => {
    // Finance, signed in for real (the deposit page's link is the real app's): records payments, drafts invoices.
    const user = await addUser(h, { id: T.a, slug: NS.a, companies: [{ id: companyA, code: 'SCA' }] }, { email: 'fina.orders@seed-a.example.com', role: 'finance' })
    finance = new Browser(h.app)
    expect((await finance.signIn(NS.a, user.email, user.password)).status).toBe(200)
    await enrolTotp(h, finance)
    SESSIONS['a.priceOnly'] = office('a', ['orders.view', 'money.price'])
  }, 60_000)

  it('a deposit request carries what was paid on it and its latest bank-details page; a TD02 names its request', async () => {
    const before = (await as(finance, 'GET', orderUrl(order.id))).order
    const deposit = before.chain.depositRequests[0]
    // The percentage as asked (30 %: a whole "30" is not trimmed to "3").
    expect(deposit).toMatchObject({ status: 'OPEN', depositPct: '30', amount: 228384, paidAmount: 0, link: null })

    const first = await as(finance, 'POST', `/payments/deposit-requests/${deposit.id}/link`, {}, 201, { 'idempotency-key': key('link') })
    const mails = h.ses.mails.length
    const second = await as(finance, 'POST', `/payments/deposit-requests/${deposit.id}/link`, { message: 'Ecco i dati per il bonifico.' }, 201, { 'idempotency-key': key('link') })
    expect(second.link.revokedLinkIds).toEqual([first.link.id])
    // The customer's page (SCR-199) says the same percentage.
    const mail = h.ses.mails.slice(mails).find((entry) => entry.outboundId === second.emailId)!
    const token = decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '')
    const page = await h.app.inject({ method: 'GET', url: '/payments/link/deposit', headers: { 'x-factory-link': token } })
    expect(page.statusCode, page.body).toBe(200)
    expect(page.json().deposit).toMatchObject({ depositPct: '30', amount: 228384, paid: false })
    // A part payment, recorded without the deposit invoice (finance issues it later).
    await as(finance, 'POST', '/payments/deposit-received', { depositRequestId: deposit.id, amount: 100000, receivedOn: TODAY, externalRef: `CRO-ORD-${newId().slice(0, 8)}`, issueDepositInvoice: false }, 201, { 'idempotency-key': key('paid') })
    const draft = (await as(finance, 'POST', '/invoicing/invoices/deposit-draft', { depositRequestId: deposit.id }, 201, { 'idempotency-key': key('draft') })).invoice

    const after = (await as(finance, 'GET', orderUrl(order.id))).order
    expect(after.chain.depositRequests[0]).toMatchObject({ id: deposit.id, status: 'OPEN', paidAmount: 100000, link: { to: second.link.to, expiresAt: second.link.expiresAt, state: 'LIVE' } })
    expect(after.chain.invoices).toEqual([expect.objectContaining({ id: draft.id, docType: 'TD02', status: 'DRAFT', depositRequestId: deposit.id })])
    // No price grain: neither the amount nor what was paid; the page's state is no money.
    const viewer = (await ok('a.viewer', 'GET', orderUrl(order.id))).order
    expect(viewer.chain.depositRequests[0]).not.toHaveProperty('paidAmount')
    expect(viewer.chain.depositRequests[0].link).toMatchObject({ state: 'LIVE' })
  })

  it('the margin % follows the margin grain; the people the record names come with their names', async () => {
    const named = (await ok('a.named', 'GET', orderUrl(order.id))).order
    const cost = await one<{ netAmount: number; costAmount: number | null }>('SELECT "netAmount", "costAmount" FROM "SalesOrder" WHERE id = $1', [order.id])
    expect(cost.costAmount).not.toBeNull()
    expect(Number(named.marginPct)).toBeCloseTo(((cost.netAmount - cost.costAmount!) * 100) / cost.netAmount, 3)
    expect(named).not.toHaveProperty('costAmount')
    expect((await ok('a.priceOnly', 'GET', orderUrl(order.id))).order).not.toHaveProperty('marginPct')

    const changed = (await ok('a.named', 'PUT', `${orderUrl(order.id)}/promise`, { version: named.version, promiseDate: addDays(TODAY, 80), reason: 'Moved with the customer.' })).order
    const actorId = changed.promiseHistory[0].actorId
    expect(changed.people).toContainEqual({ id: actorId, name: 'oscar owner' }) // B-CP-011: the Owner's session (was the Sales worker's)
    // Ids of no person (the test sessions' earlier changes) are simply not named.
    expect(changed.people.map((person: Json) => person.id)).toEqual([actorId])
  })
})

// ---- B-SA-001: every order event names its order's own customer (the live wall for people limited to some customers) ----
describe('live: every order event names its order’s customer (B-SA-001)', () => {
  it('each sales_order.* row the commands above wrote carries partyId = the order row’s own (never a caller’s value)', async () => {
    const rows = await admin<{ type: string; party: string | null; own: string }>(
      `SELECT e.type, e.payload->>'partyId' AS party, o."partyId"::text AS own
         FROM "OutboxEvent" e JOIN "SalesOrder" o ON o.id = (e.payload->>'orderId')::uuid
        WHERE e.type LIKE 'sales_order.%' AND e."tenantId" = ANY($1::uuid[])
        ORDER BY e.type, e.id`,
      [Object.values(T)],
    )
    // The emitters this file runs: the acceptance, the moves (person and system), the promise, the close.
    expect([...new Set(rows.map((row) => row.type))]).toEqual(expect.arrayContaining(['sales_order.created', 'sales_order.status_changed', 'sales_order.promise_changed']))
    expect(rows.filter((row) => row.party !== row.own)).toEqual([])
    // The order of tenant e (F-SA-201) moved by the system and by a person: both name P1 of tenant e.
    expect(new Set((await statusEvents(seeded.e.quality.production.salesOrderId)).map((row) => row.payload.partyId))).toEqual(new Set([idIn('e', 'party:P1')]))
  })
})
// ---- end B-SA-001

// ---- B-SA-034 (Sales page plan P17): the order read names its own live watch list and who changed each part last ------------
describe('live: the order read names its own watch list and its last change per part (B-SA-034)', () => {
  const order = () => seeded.a.quality.production.salesOrderId
  const workOrder = () => seeded.a.quality.production.workOrderId
  // Later than anything the seeds or the commands above wrote (the seeds' future follows the calendar by a few days).
  const later = (days: number) => `now() + interval '${days} days'`
  let customerName = ''
  let officePerson = { id: '', name: '' }

  beforeAll(async () => {
    customerName = (await one<{ name: string }>(`SELECT COALESCE("tradeName", "legalName") AS name FROM "Party" WHERE id = $1`, [P1])).name
    officePerson = await one<{ id: string; name: string }>(`SELECT id, "displayName" AS name FROM "User" WHERE "tenantId" = $1 AND email = 'olga.orders@seed-a.example.com'`, [T.a])
    // The newest rows of each part: the customer itself on the order (then another partner, later, who is never named), the floor on
    // the work order, an office person on the shipment.
    const row = (audience: string, actorId: string, recordType: string, recordId: string, at: string, partyId: string | null) =>
      `INSERT INTO "AuditLog" (id, "tenantId", "companyId", "partyId", at, audience, "actorId", action, "recordType", "recordId", "requestId")
       VALUES ('${newId()}', '${T.a}', '${companyA}', ${partyId ? `'${partyId}'` : 'NULL'}, ${at}, '${audience}', '${actorId}', 'test.sa034', '${recordType}', '${recordId}', 'sa034');`
    await admin(
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       ${row('PARTNER', newId(), 'SalesOrder', order(), later(30), P1)}
       ${row('PARTNER', newId(), 'SalesOrder', order(), later(31), P3)}
       ${row('FLOOR', newId(), 'WorkOrder', workOrder(), later(30), null)}
       ${row('OFFICE', officePerson.id, 'Shipment', seeded.a.shipmentId, later(30), null)}
       COMMIT;`,
    )
  })

  it('live.events: declared types only, each with the parts it re-reads (orders, pieces, holds, dates, money, files)', async () => {
    const { live } = (await ok('a.production', 'GET', orderUrl(order()))).order
    const declared = new Set(EVENT_CATALOGUE.types())
    const types = live.events.map((entry: Json) => entry.type)
    expect(types.every((type: string) => declared.has(type))).toBe(true)
    expect(new Set(types).size).toBe(types.length)
    const partsOf = (type: string) => live.events.find((entry: Json) => entry.type === type)?.parts
    expect(partsOf('sales_order.status_changed')).toEqual(['order', 'lines', 'changes'])
    expect(partsOf('production.scan_recorded')).toEqual(['lines', 'headline'])
    expect(partsOf('file.available')).toEqual(['files'])
    expect(partsOf('shipment.status_changed')).toEqual(['money', 'shipments'])
    expect(partsOf('brand_production.stage_reached')).toEqual(['headline', 'people'])
  })

  it('live.ids: the order’s own records; work orders only for a reader who reaches them; never a party id', async () => {
    const production = (await ok('a.production', 'GET', orderUrl(order()))).order
    expect(production.live.ids.shipmentIds).toContain(seeded.a.shipmentId)
    expect(production.live.ids.workOrderIds).toContain(workOrder())
    expect((await ok('a.production.p1', 'GET', orderUrl(order()))).order.live.ids.workOrderIds).toContain(workOrder())
    // Without workorders.view the page names no work order to listen to (it shows none either).
    expect((await ok('a.sales', 'GET', orderUrl(order()))).order.live.ids.workOrderIds).toEqual([])
    expect(JSON.stringify(production.live)).not.toContain(P1)
    // Another customer's person: the words of an unknown order, no watch list.
    expect((await call('a.otherParty', 'GET', orderUrl(order()))).status).toBe(404)
  })

  it('lastChange: the order’s own customer by name (another partner never), "the floor" (never a worker), an office person by name', async () => {
    const { lastChange } = (await ok('a.production', 'GET', orderUrl(order()))).order
    expect(lastChange.order.by).toEqual({ kind: 'CUSTOMER', name: customerName, words: { it: customerName, en: customerName } })
    const customerRow = await one<{ at: Date }>(`SELECT at FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND "partyId" = $2 AND action = 'test.sa034'`, [order(), P1])
    expect(lastChange.order.at).toBe(customerRow.at.toISOString())
    expect(lastChange.work.by).toEqual({ kind: 'FLOOR', name: null, words: { it: 'Il reparto', en: 'The floor' } })
    expect(lastChange.shipments.by).toEqual({ kind: 'OFFICE', name: officePerson.name, words: { it: officePerson.name, en: officePerson.name } })
    // Who changed it never names a work order the reader does not reach: no work part without workorders.view.
    expect((await ok('a.sales', 'GET', orderUrl(order()))).order.lastChange.work).toBeNull()
    expect(JSON.stringify(lastChange)).not.toMatch(/worker|operator|station/i)
  })
})
// ---- end B-SA-034

// ---- B-SA-035 (Sales page plan N2, N8): the order read's lines carry their picture and the artwork the reader may open ----------
describe('the lines carry their picture and their artwork count, by the reader’s file right (B-SA-035)', () => {
  const order = () => seeded.a.quality.production.salesOrderId
  const files = { main: '', red: '', artwork: '', pending: '' }

  /** A made-up file of a record, written as the office's runtime login writes rows (the database's file rules apply). */
  async function fileOn(recordType: string, recordId: string, input: { name: string; kind: 'PHOTO' | 'DOCUMENT'; contentType: string; category?: 'ARTWORK'; status?: 'AVAILABLE' | 'PENDING_UPLOAD' }): Promise<string> {
    const fileId = newId()
    const account = await one<{ id: string }>(`SELECT id FROM "IntegrationAccount" WHERE "tenantId" = $1 AND provider = 'R2' ORDER BY id LIMIT 1`, [T.a])
    const at = new Date()
    await h.database.withScope({ audience: 'office', tenantId: T.a, actorId: newId() }, (client) =>
      client.storedFile.create({
        data: seedFile(T.a, {
          id: fileId,
          companyId: companyA,
          recordType,
          recordId,
          kind: input.kind,
          ...(input.category ? { category: input.category } : {}),
          originalName: input.name,
          contentType: input.contentType,
          sizeBytes: 2048,
          storeAccountId: account.id,
          storageKey: `t/${T.a}/c/${companyA}/2026/${newId()}`,
          status: input.status ?? 'AVAILABLE',
          ...(input.status === 'PENDING_UPLOAD' ? {} : { availableAt: at }),
          visibility: ['OFFICE'],
          createdAt: at,
          updatedAt: at,
        }),
        select: { id: true },
      }),
    )
    return fileId
  }

  beforeAll(async () => {
    // The order's own style and its RED colourway (SEED-SO-0002 is the production seed's order: its lines are of SEED-JKT-02).
    const lines = await admin<{ id: string; colour: string; styleId: string; colourwayId: string }>(`SELECT l.id, c.code AS colour, l."styleId"::text AS "styleId", l."colourwayId"::text AS "colourwayId" FROM "SalesOrderLine" l JOIN "Colourway" c ON c.id = l."colourwayId" WHERE l."orderId" = $1 ORDER BY l.seq`, [order()])
    expect(lines.map((line) => line.colour).sort()).toEqual(['BLK', 'RED'])
    expect(new Set(lines.map((line) => line.styleId)).size).toBe(1)
    const style = lines[0]!.styleId
    const red = lines.find((line) => line.colour === 'RED')!.colourwayId
    // The style's main picture, RED's own picture (not the main one), and the BLK line's artwork (one ready, one still uploading).
    files.main = await fileOn('Style', style, { name: 'T-SA035 jacket front.jpg', kind: 'PHOTO', contentType: 'image/jpeg' })
    files.red = await fileOn('Colourway', red, { name: 'T-SA035 jacket red.jpg', kind: 'PHOTO', contentType: 'image/jpeg' })
    const blkLine = lines.find((line) => line.colour === 'BLK')!.id
    files.artwork = await fileOn('SalesOrderLine', blkLine, { name: 'T-SA035 logo.pdf', kind: 'DOCUMENT', contentType: 'application/pdf', category: 'ARTWORK' })
    files.pending = await fileOn('SalesOrderLine', blkLine, { name: 'T-SA035 logo v2.pdf', kind: 'DOCUMENT', contentType: 'application/pdf', category: 'ARTWORK', status: 'PENDING_UPLOAD' })
    await admin(`UPDATE "StyleImage" SET "isMain" = false WHERE "tenantId" = $1 AND "styleId" = $2`, [T.a, style])
    await admin(
      `INSERT INTO "StyleImage" (id, "tenantId", "styleId", "colourwayId", "fileId", kind, seq, "isMain") VALUES ($1, $2, $3, NULL, $4, 'PHOTO', 0, true), ($5, $2, $3, $6, $7, 'PHOTO', 1, false)`,
      [newId(), T.a, style, files.main, newId(), red, files.red],
    )
  })

  const linesOf = async (session: string): Promise<Record<'BLK' | 'RED', Json>> => {
    const read = (await ok(session, 'GET', orderUrl(order()))).order
    const of = (colour: string) => (read.lines as Json[]).find((line) => line.colourway?.code === colour)!
    return { BLK: of('BLK'), RED: of('RED') }
  }

  it('with files.read: the colourway’s own picture, else the style’s main one; no small address before its preview exists', async () => {
    const lines = await linesOf('a.files')
    expect(lines.RED.picture).toEqual({ fileId: files.red, contentType: 'image/jpeg', small: null })
    expect(lines.BLK.picture).toEqual({ fileId: files.main, contentType: 'image/jpeg', small: null })
  })

  it('artworkCount counts the files the reader may open: ready ones only, and only with files.read over their company', async () => {
    const lines = await linesOf('a.files')
    expect(lines.BLK.artworkCount).toBe(1)
    expect(lines.RED.artworkCount).toBe(0)
    // files.read of another company only: neither the pictures nor the artwork of company A's files.
    const other = await linesOf('a.files.companyB')
    expect([other.BLK.picture, other.RED.picture]).toEqual([null, null])
    expect([other.BLK.artworkCount, other.RED.artworkCount]).toEqual([0, 0])
  })

  it('without files.read: no picture and no artwork counted (the page draws its placeholder); another customer’s person: 404', async () => {
    const lines = await linesOf('a.viewer')
    expect([lines.BLK.picture, lines.RED.picture]).toEqual([null, null])
    expect([lines.BLK.artworkCount, lines.RED.artworkCount]).toEqual([0, 0])
    expect(JSON.stringify(lines)).not.toContain(files.main)
    expect((await call('a.otherParty', 'GET', orderUrl(order()))).status).toBe(404)
  })

  // ---- B-SA-035b: the artwork files themselves (the Lines chip opens them in the thread's ONE viewer), by the same rule as the count.
  it('B-SA-035b: the line lists the artwork files the reader may open — the same ones artworkCount counts, never one still uploading', async () => {
    const lines = await linesOf('a.files')
    expect(lines.BLK.artwork).toEqual([{ fileId: files.artwork, name: 'T-SA035 logo.pdf', contentType: 'application/pdf', sizeBytes: 2048 }])
    expect(lines.BLK.artwork).toHaveLength(lines.BLK.artworkCount)
    expect(lines.RED.artwork).toEqual([])
    expect(JSON.stringify(lines.BLK.artwork)).not.toContain(files.pending)
    // files.read of another company only, or none: no file named at all (the chip is not drawn).
    const other = await linesOf('a.files.companyB')
    expect([other.BLK.artwork, other.RED.artwork]).toEqual([[], []])
    const viewer = await linesOf('a.viewer')
    expect([viewer.BLK.artwork, viewer.RED.artwork]).toEqual([[], []])
    expect(JSON.stringify(viewer)).not.toContain('T-SA035 logo')
  })

  it('B-SA-035b: a size-grid line names no rider (rider: null), whatever the reader holds', async () => {
    const lines = await linesOf('a.files')
    expect([lines.BLK.rider, lines.RED.rider]).toEqual([null, null])
  })
  // ---- end B-SA-035b
})
// ---- end B-SA-035

// ---- B-OP-020 (order page plan N1; 13-backend §2, §3; review R-20, R-22, B3): the yes in place, the tabs' counts, the words' grain ----
/**
 * Tenant f: the orders, credit and changes seed — SEED-SO-W39-01 waits (PENDING_APPROVAL) with its CREDIT_OVERRIDE request for
 * Finance, asked by the member; SEED-SO-W39-02 keeps its old SALES_ORDER_CHANGE request for the Owner role (R-20: the seed is kept,
 * B-OP-010 asks no new one). Here the member also asks W39-01's own SALES_ORDER yes of the Owner role, through the engine as the
 * order's making asks it (no rule of the kind in this tenant: the module's own rule names the role). The order read lists each
 * request only to a reader the engine's list shows it to, with the engine's decide rule: the approver (the seeded Owner) may say yes,
 * the asker is held (never one's own yes) and may take it back, every other reader gets the count alone.
 */
describe('the order read carries its open requests for a yes, decided in place (B-OP-020)', () => {
  const NS_F = 'orders-f'
  const TF = seedUuid(NS_F, 'tenant')
  let depth: SalesOrdersDepthSeed
  let askedId = ''
  const person = (actorId: () => string, permissions: Permission[], parties: Grant['parties'] = 'all'): (() => SessionContext) => () => ({
    audience: 'office',
    tenantId: TF,
    actorId: actorId(),
    grants: [grant(permissions, 'all', parties)],
  })
  const read = async (session: string, orderId: string): Promise<Json> => (await ok(session, 'GET', orderUrl(orderId))).order

  beforeAll(async () => {
    await seedCore({ db: h.database, namespace: NS_F })
    await seedAccounting({ db: h.database, namespace: NS_F })
    depth = await seedSalesOrdersDepth({ db: h.database, namespace: NS_F })
    const ownerRole = await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'owner'`, [TF])
    const caller = callerFor(h.database, { audience: 'office', tenantId: TF, actorId: depth.memberId, requestId: newId(), grants: [grant(['orders.view', 'orders.manage', 'approvals.request'])] })
    const { result } = await command(caller, { name: 'approvals.request', input: { kind: 'SALES_ORDER', recordId: depth.waitingOrderId } }, (tools) =>
      askApproval(tools, { kind: 'SALES_ORDER', recordId: depth.waitingOrderId, requester: { userId: depth.memberId }, whenNoRule: { approverRoleId: ownerRole.id, requireStepUp: false } }),
    )
    if (!result.asked) throw new Error('the SALES_ORDER request was not asked')
    askedId = result.taskId
    SESSIONS['f.owner'] = person(() => depth.ownerId, ['orders.view', 'approvals.view', 'approvals.decide', 'money.price'])
    SESSIONS['f.member'] = person(() => depth.memberId, ['orders.view', 'approvals.view', 'approvals.request'])
    SESSIONS['f.reader'] = person(newId, ['orders.view', 'approvals.view'])
    SESSIONS['f.noApprovals'] = person(newId, ['orders.view'])
    SESSIONS['f.p1'] = person(newId, ['orders.view', 'approvals.view'], [depth.partyId])
    SESSIONS['f.otherParty'] = person(newId, ['orders.view', 'approvals.view', 'approvals.decide', 'money.price'], [seedUuid(NS_F, 'party:P3')])
  }, 240_000)

  it('the approver sees its yes allowed (and the no), never the request it may not see; the live list names what it listed', async () => {
    const order = await read('f.owner', depth.waitingOrderId)
    expect(order.status).toBe('PENDING_APPROVAL')
    expect(order.openApprovals).toEqual([
      expect.objectContaining({
        taskId: askedId,
        kind: 'SALES_ORDER',
        kindLabel: { en: 'Sales order', it: 'Ordine di vendita' },
        requester: { name: expect.any(String), me: false },
        approver: expect.objectContaining({ kind: 'ROLE', me: true }),
        version: expect.any(Number),
        requireStepUp: false,
        approve: { allowed: true, why: null },
        reject: { allowed: true, why: null },
        withdraw: { allowed: false, why: APPROVAL_REFUSALS.NOT_REQUESTER },
      }),
    ])
    // The credit hold's request (Finance decides it; the Owner neither asked it nor reads credit): counted, never named.
    expect(order.openApprovalsHidden).toBe(1)
    expect(JSON.stringify(order)).not.toContain(depth.taskIds.override1)
    expect(order.live.ids.approvalTaskIds).toEqual([askedId])
    // No money fact of the request in the order read (the decide window reads them by grain).
    expect(Object.keys(order.openApprovals[0]).sort()).toEqual(['approve', 'approver', 'kind', 'kindLabel', 'reject', 'requestedAt', 'requester', 'requireStepUp', 'taskId', 'version', 'withdraw'])
  })

  it('the asker sees both of its requests held for its own yes, and may take each back', async () => {
    const order = await read('f.member', depth.waitingOrderId)
    expect(order.openApprovals.map((row: Json) => row.taskId)).toEqual([depth.taskIds.override1, askedId])
    for (const row of order.openApprovals as Json[]) {
      expect(row.requester).toEqual({ name: expect.any(String), me: true })
      expect(row.approve).toEqual({ allowed: false, why: APPROVAL_REFUSALS.OWN_REQUEST })
      expect(row.reject).toEqual({ allowed: false, why: APPROVAL_REFUSALS.OWN_REQUEST })
      expect(row.withdraw).toEqual({ allowed: true, why: null })
    }
    expect(order.openApprovalsHidden).toBe(0)
    expect(order.openApprovals[0]).toMatchObject({ kind: 'CREDIT_OVERRIDE', kindLabel: { en: 'Credit override' } })
  })

  it('another reader of approvals sees the yes held (not its approver); without approvals.view only the count; another customer’s person: 404', async () => {
    const reader = await read('f.reader', depth.waitingOrderId)
    expect(reader.openApprovals).toEqual([expect.objectContaining({ taskId: askedId, approve: { allowed: false, why: APPROVAL_REFUSALS.NOT_APPROVER }, withdraw: { allowed: false, why: APPROVAL_REFUSALS.NOT_REQUESTER } })])
    expect(reader.openApprovalsHidden).toBe(1)
    // A person limited to the order's own customer reads them as the production unit does (the customer wall keeps its own).
    const own = await read('f.p1', depth.waitingOrderId)
    expect(own.openApprovals.map((row: Json) => row.taskId)).toEqual([askedId])
    expect(own.openApprovalsHidden).toBe(1)
    const none = await read('f.noApprovals', depth.waitingOrderId)
    expect(none).toMatchObject({ openApprovals: [], openApprovalsHidden: 2 })
    expect(none.live.ids.approvalTaskIds).toEqual([])
    const other = await call('f.otherParty', 'GET', orderUrl(depth.waitingOrderId))
    expect(other.status).toBe(404)
    expect(JSON.stringify(other.body)).not.toContain(askedId)
  })

  it('the yes in place: the approver decides at the version read; the order still waits for its credit hold, the request leaves the list', async () => {
    const before = await read('f.owner', depth.waitingOrderId)
    const row = before.openApprovals.find((entry: Json) => entry.taskId === askedId)
    // Never the asker's own yes (rule 42), whatever the page shows.
    expect([403, 409]).toContain((await call('f.member', 'POST', `/approvals/tasks/${askedId}/approve`, { version: row.version })).status)
    await ok('f.owner', 'POST', `/approvals/tasks/${askedId}/approve`, { version: row.version })
    const after = await read('f.owner', depth.waitingOrderId)
    expect(after.status).toBe('PENDING_APPROVAL')
    expect(after.openApprovals).toEqual([])
    expect(after.openApprovalsHidden).toBe(1)
    expect(after.live.ids.approvalTaskIds).toEqual([])
  })

  it('the old SALES_ORDER_CHANGE request of SEED-SO-W39-02 (R-20) is listed to its approver and decidable in place', async () => {
    const order = await read('f.owner', depth.orderId)
    expect(order.openApprovals).toEqual([expect.objectContaining({ taskId: depth.taskIds.reapproval2, kind: 'SALES_ORDER_CHANGE', approver: expect.objectContaining({ me: true }), reject: { allowed: true, why: null } })])
    // Its yes follows the engine's re-check (a request written by the seed may read as changed since it was asked): allowed, or held in words.
    expect([null, APPROVAL_REFUSALS.STALE]).toContain(order.openApprovals[0].approve.why)
    // The approved credit override of the same order waits no more: not listed, not counted.
    expect(order.openApprovalsHidden).toBe(0)
    expect(JSON.stringify(order.openApprovals)).not.toContain(depth.taskIds.override2)
  })

  it('badges: issued invoices and open deposits on the Money tab, shipments not cancelled on the Shipments tab; no Changes count (R-22)', async () => {
    const order = await read('f.owner', depth.orderId)
    const open = (order.chain.depositRequests as Json[]).filter((row) => row.status === 'OPEN')
    expect(open.map((row) => row.id)).toContain(depth.extraDepositId)
    expect(order.badges).toEqual({
      money: { invoices: (order.chain.invoices as Json[]).filter((row) => row.status !== 'DRAFT').length, openDeposits: open.length },
      shipments: (order.chain.shipments as Json[]).filter((row) => row.status !== 'CANCELLED').length,
    })
    expect(order.badges).not.toHaveProperty('changes')
    // An order that shipped: its shipments counted (tenant a's SEED-SO-0002 left with SH-0001).
    const shipped = await ok('a.production', 'GET', orderUrl(seeded.a.quality.production.salesOrderId))
    expect(shipped.order.badges.shipments).toBe((shipped.order.chain.shipments as Json[]).filter((row) => row.status !== 'CANCELLED').length)
    expect(shipped.order.badges.shipments).toBeGreaterThan(0)
  })

  it('B3: what the settlement misses comes in words with the price grain only; without it, the codes alone', async () => {
    const priced = (await read('f.owner', depth.orderId)).settlement
    expect(priced.settled).toBe(false)
    expect(priced.missing.length).toBeGreaterThan(0)
    for (const gap of priced.missing as Json[]) expect(typeof gap.message).toBe('string')
    const plain = (await read('f.reader', depth.orderId)).settlement
    expect(plain.missing.map((gap: Json) => gap.code)).toEqual(priced.missing.map((gap: Json) => gap.code))
    for (const gap of plain.missing as Json[]) expect(Object.keys(gap)).toEqual(['code'])
  })

  it('live: a request for a yes asked, decided, taken back or found changed re-reads the order and its changes (never a rule change)', async () => {
    const { live } = await read('f.owner', depth.orderId)
    const partsOf = (type: string) => (live.events as Json[]).find((entry) => entry.type === type)?.parts
    for (const type of ['approval.requested', 'approval.decided', 'approval.withdrawn', 'approval.stale']) expect(partsOf(type)).toEqual(['order', 'changes'])
    expect(partsOf('approval.rule_changed')).toBeUndefined()
  })

  // ── B-OO-003 (order overview N3): a waiting order is cancelled; its requests for a yes are withdrawn with it ──────────────────
  it('B-OO-003: a person with orders.manage cancels the waiting order; its SALES_ORDER and CREDIT_OVERRIDE requests are withdrawn', async () => {
    SESSIONS['f.sales'] = person(newId, ['orders.view', 'orders.manage'])
    SESSIONS['f.otherSales'] = person(newId, ['orders.view', 'orders.manage'], [seedUuid(NS_F, 'party:P3')])
    const orderId = depth.waitingOrderId
    const taskStatus = async (taskId: string) => (await one<{ status: string }>('SELECT status::text AS status FROM "ApprovalTask" WHERE id = $1', [taskId])).status
    // W39-01 still waits for its credit hold (its yes was said above): the member asks the order's yes once more, as before.
    const ownerRole = await one<{ id: string }>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'owner'`, [TF])
    const caller = callerFor(h.database, { audience: 'office', tenantId: TF, actorId: depth.memberId, requestId: newId(), grants: [grant(['orders.view', 'orders.manage', 'approvals.request'])] })
    const { result } = await command(caller, { name: 'approvals.request', input: { kind: 'SALES_ORDER', recordId: orderId } }, (tools) =>
      askApproval(tools, { kind: 'SALES_ORDER', recordId: orderId, requester: { userId: depth.memberId }, whenNoRule: { approverRoleId: ownerRole.id, requireStepUp: false } }),
    )
    if (!result.asked) throw new Error('the second SALES_ORDER request was not asked')
    expect([await taskStatus(result.taskId), await taskStatus(depth.taskIds.override1)]).toEqual(['PENDING', 'PENDING'])

    const order = await read('f.sales', orderId)
    expect(order.status).toBe('PENDING_APPROVAL')
    expect(order.actions.find((action: Json) => action.action === 'cancel')).toMatchObject({ allowed: true, needsReason: true, held: null })
    // The impact check of a waiting order: no "goods left" STATE block.
    const check = await ok('f.sales', 'GET', `${orderUrl(orderId)}/cancel-check`)
    expect(check.impact.blocks.map((item: Json) => item.code)).not.toContain('STATE')
    // Read-only: 403; a person limited to another customer: the words of an unknown order (404); nothing withdrawn.
    const body = { version: order.version, reason: 'Made-up: the customer withdrew while it waited.' }
    await refused('f.reader', 'POST', `${orderUrl(orderId)}/cancel`, body, 403)
    await refused('f.otherSales', 'POST', `${orderUrl(orderId)}/cancel`, body, 404)
    expect([await taskStatus(result.taskId), await taskStatus(depth.taskIds.override1)]).toEqual(['PENDING', 'PENDING'])

    const cancelled = (await ok('f.sales', 'POST', `${orderUrl(orderId)}/cancel`, body)).order
    expect(cancelled).toMatchObject({ status: 'CANCELLED', version: order.version + 1 })
    expect([await taskStatus(result.taskId), await taskStatus(depth.taskIds.override1)]).toEqual(['WITHDRAWN', 'WITHDRAWN'])
    expect((await auditsOf(orderId)).find((row) => row.after?.status === 'CANCELLED')).toMatchObject({ before: { status: 'PENDING_APPROVAL' }, reason: body.reason, audience: 'OFFICE' })
    expect((await statusEvents(orderId)).at(-1)!.payload).toMatchObject({ from: 'PENDING_APPROVAL', to: 'CANCELLED', by: 'person' })
  })
  // ── end B-OO-003 ──
})
// ---- end B-OP-020

// ---- B-OP-023 (order page plan N5; review R-7): the order's shipments with their carrier, tracking, DDT and the tracking door -------
/**
 * Tenant a: SEED-SO-0002 left with SH-0001 (Seed Express, two parcels with carrier labels, DDT 144 live); SEED-SO-0003's SH-0002 is a
 * DRAFT for the same carrier with no label. A reader of shipping sees the carrier and the tracking (the labels' numbers, live; then a
 * number typed by hand, not live); a reader of orders alone sees neither (withheld) but the DDT and how it travels; the tracking door
 * says why it is held: the shipment's own refusal first (LABELLED, NOT_A_CARRIER, CANCELLED), then the right (NO_RIGHT).
 */
describe('the order read’s shipments: carrier, tracking, DDT and whether the number may be typed here (B-OP-023)', () => {
  const so2 = () => seeded.a.quality.production.salesOrderId
  const so3 = () => seeded.a.quality.serialSalesOrderId
  const shipmentOf = async (session: string, orderId: string, shipmentId: string): Promise<Json> => ((await ok(session, 'GET', orderUrl(orderId))).order.chain.shipments as Json[]).find((row) => row.id === shipmentId)!

  beforeAll(() => {
    SESSIONS['a.shipping'] = office('a', ['orders.view', 'shipping.view', 'shipping.manage'])
    SESSIONS['a.shipView'] = office('a', ['orders.view', 'shipping.view'])
  })

  it('a shipment that left with carrier labels: its carrier, the labels’ numbers (live), its live DDT; typing is held (LABELLED)', async () => {
    const row = await shipmentOf('a.shipping', so2(), seeded.a.shipmentId)
    expect(row).toMatchObject({ number: 'SEED-SH-0001', transportBy: 'CARRIER', carrier: { code: 'seed-express', name: 'Seed Express' }, withheld: [] })
    expect(row.tracking).toMatchObject({ source: 'PARCELS', number: null, live: true })
    expect((row.tracking.parcels as Json[]).map((parcel) => parcel.number).sort()).toEqual(['SEEDTRACK0001', 'SEEDTRACK0002'])
    expect(row.ddt).toMatchObject({ number: expect.stringMatching(/^144\//) })
    expect(row.mayTypeTracking).toMatchObject({ allowed: false, code: 'LABELLED' })
    const stored = await one<{ version: number; siteId: string }>(`SELECT version, "siteId" FROM "Shipment" WHERE id = $1`, [seeded.a.shipmentId])
    expect([row.version, row.siteId]).toEqual([stored.version, stored.siteId])
  })

  it('a reader of orders alone: how it travels and its DDT, never its carrier or tracking (withheld); the door held for the right', async () => {
    const row = await shipmentOf('a.viewer', so2(), seeded.a.shipmentId)
    expect(row).toMatchObject({ transportBy: 'CARRIER', carrier: null, tracking: null, withheld: ['shipments.detail'], mayTypeTracking: { allowed: false, code: 'NO_RIGHT' } })
    expect(row.ddt).toMatchObject({ number: expect.stringMatching(/^144\//) })
    expect(JSON.stringify(row)).not.toContain('SEEDTRACK')
  })

  it('a draft for a carrier: typed here by a person who manages shipments (TYPED, not live); a reader of shipping alone is held for the right', async () => {
    const before = await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)
    expect(before.mayTypeTracking).toEqual({ allowed: true, code: null, why: null })
    expect(before.tracking).toBeNull()
    expect((await shipmentOf('a.shipView', so3(), seeded.a.draftShipmentId)).mayTypeTracking).toMatchObject({ allowed: false, code: 'NO_RIGHT' })
    await ok('a.shipping', 'PUT', `/shipping/shipments/${seeded.a.draftShipmentId}/own-transport/tracking`, { version: before.version, trackingNumber: 'T-OP023-BRT-0001' })
    const typed = await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)
    expect(typed.tracking).toEqual({ number: 'T-OP023-BRT-0001', source: 'TYPED', parcels: [], live: false, url: null })
    expect(typed.version).toBeGreaterThan(before.version)
    expect((await shipmentOf('a.viewer', so3(), seeded.a.draftShipmentId)).tracking).toBeNull()
    // F-OP-135 (B-OP-034): the link typed beside it is the row's Track › (https only); never to a reader without shipping.view.
    await ok('a.shipping', 'PUT', `/shipping/shipments/${seeded.a.draftShipmentId}/own-transport/tracking`, { version: typed.version, trackingNumber: 'T-OP023-BRT-0001', trackingUrl: 'https://track.example.com/T-OP023-BRT-0001' })
    expect((await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)).tracking).toMatchObject({ source: 'TYPED', url: 'https://track.example.com/T-OP023-BRT-0001' })
    expect(JSON.stringify(await shipmentOf('a.viewer', so3(), seeded.a.draftShipmentId))).not.toContain('track.example.com')
    // Cleared again: the rows after this one read the draft as before.
    const linked = await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)
    await ok('a.shipping', 'PUT', `/shipping/shipments/${seeded.a.draftShipmentId}/own-transport/tracking`, { version: linked.version, trackingNumber: 'T-OP023-BRT-0001', trackingUrl: null })
  })

  it('our own van takes no tracking number (NOT_A_CARRIER); a cancelled shipment none either (CANCELLED)', async () => {
    const draft = await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)
    await ok('a.shipping', 'PUT', `/shipping/shipments/${seeded.a.draftShipmentId}/own-transport`, { version: draft.version, mode: 'OWN_VAN' })
    const van = await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)
    expect(van).toMatchObject({ transportBy: 'SENDER', tracking: null, mayTypeTracking: { allowed: false, code: 'NOT_A_CARRIER' } })
    await admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE "Shipment" SET status = 'CANCELLED', "cancelledAt" = now(), "cancelReason" = 'T-OP023 made up' WHERE id = '${seeded.a.draftShipmentId}'; COMMIT;`)
    expect((await shipmentOf('a.shipping', so3(), seeded.a.draftShipmentId)).mayTypeTracking).toMatchObject({ allowed: false, code: 'CANCELLED' })
  })
})
// ---- end B-OP-023
