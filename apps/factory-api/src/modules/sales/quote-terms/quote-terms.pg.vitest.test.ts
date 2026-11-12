import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, fixedClock } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedEmail } from '../../../../../../packages/factory-db/seed/email'
import { seed as seedSalesPricing } from '../../../../../../packages/factory-db/seed/sales-pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { callerFor } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import { carryScheduleAfterYes } from './carry'
import { runQuoteValidity } from './validity'

/**
 * A quote's delivery terms, delivery schedule and validity (B-W2b-294; SAL-145, SAL-151, SAL-162) through the app's real routes
 * on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and B-W2b-280's
 * QuoteVersion_w2b5_terms / QuoteLineDelivery_guard / SalesOrderLineDelivery_guard are real), on the seeds up to the sales
 * pricing and email out (company A's FAKE mail account and conversation identity; the brand P1 = SEED-C1 with its buyer; the
 * jacket SEED-JKT-01 in BLK sizes 50/52/54). A version is sent or accepted here by the database's admin login (the send and
 * the link are B-W1-24's own tests); the validity job runs on a fixed clock. Every word and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/sales/quote-terms`.
 */

vi.setConfig({ testTimeout: 90_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'w2b294-terms'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const JKT01 = idOf('product:style:JKT-01')
const BLK = idOf('product:colourway:JKT-01:BLK')
const GRID = [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }, { size: '54', quantity: 2 }]

const roleOf = (key: string): Permission[] => {
  const template = templateOf(key)!
  return [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
}
const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const office = (permissions: Permission[]): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = { sales: office(roleOf('sales')), viewer: office(['quotes.view'] as Permission[]) }
const log = { info() {}, warn() {}, error() {} }

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': `q-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const events = async (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [T, type, subject])

let seeded: Awaited<ReturnType<typeof seedSalesPricing>>
let sentFacts: Json
const today = businessDate(new Date())

/** A new DRAFT quote for P1 (its PO number given) with one jacket line, no deposit. */
async function draftQuote(): Promise<Json> {
  let { quote } = await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: `PO-${run}-${++serial}`, depositPct: null }, 201)
  ;({ quote } = await ok('sales', 'POST', `/sales/quotes/${quote.id}/lines`, { version: quote.version, styleId: JKT01, colourwayId: BLK, sizes: GRID, unitPrice: '450' }, 201))
  return quote
}

/** The version SENT by the admin login (what B-W1-24's send writes: the buyer and address as sent, the PDF hash, who sent it). */
async function markSent(quote: Json, sentAt: Date, validUntil: string): Promise<void> {
  await admin(`UPDATE "QuoteVersion" SET "validUntil" = $2::date WHERE id = $1`, [quote.current.id, validUntil])
  await admin(`UPDATE "QuoteVersion" SET status = 'SENT', "sentAt" = $2, "sentById" = $3, "documentSha256" = $4, "billTo" = $5::jsonb, "shipTo" = $6::jsonb, "termsVersion" = 'made-up-1' WHERE id = $1`, [
    quote.current.id,
    sentAt,
    sentFacts.sentById,
    'b'.repeat(64),
    JSON.stringify(sentFacts.billTo),
    JSON.stringify(sentFacts.shipTo),
  ])
  await admin(`UPDATE "Quote" SET status = 'SENT' WHERE id = $1`, [quote.id])
}

beforeAll(async () => {
  h = await startHarness('quote_terms')
  await seedCore({ db: h.database, namespace: NS })
  await seedEmail({ db: h.database, namespace: NS })
  seeded = await seedSalesPricing({ db: h.database, namespace: NS })
  sentFacts = await one(`SELECT "billTo", "shipTo", "sentById" FROM "QuoteVersion" WHERE id = $1`, [seeded.sentQuote.versionId])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

let quote: Json
let lineId = ''

describe('delivery terms (SAL-162)', () => {
  it("reads a draft's terms: no Incoterm yet, ship as ready, the customer's own Incoterm offered, every piece at the promise date", async () => {
    quote = await draftQuote()
    lineId = quote.lines[0].id
    const terms = await ok('viewer', 'GET', `/sales/quotes/${quote.id}/terms`)
    expect(terms).toMatchObject({ editable: true, incoterm: null, shipComplete: false, shipWords: 'Spedizione al pronto: ogni consegna parte quando è pronta.', acceptanceMode: 'SIGN', validity: { state: 'NOT_SENT', reminderOn: null } })
    expect(terms.lines).toEqual([expect.objectContaining({ lineId, seq: 10, label: 'SEED-JKT-01 BLK', quantity: 8, deliveries: [], atPromiseDate: { '50': 2, '52': 4, '54': 2 } })])
    expect(terms.incoterms.map((rule: Json) => rule.code)).toContain('DAP')
  })

  it('saves the Incoterm and its place and ship complete; refuses in words an unknown rule, a place without one, paying without a deposit', async () => {
    const terms = await ok('sales', 'PUT', `/sales/quotes/${quote.id}/terms`, { version: quote.version, incoterm: 'dap', incotermPlace: 'Seedville warehouse', shipComplete: true })
    expect(terms).toMatchObject({ incoterm: 'DAP', incotermPlace: 'Seedville warehouse', incotermWords: 'DAP Seedville warehouse (Reso al luogo di destinazione)', shipComplete: true })
    quote = { ...quote, version: terms.quoteVersion }
    expect((await no('sales', 'PUT', `/sales/quotes/${quote.id}/terms`, { version: quote.version, incoterm: 'XYZ' }, 400)).issues[0].path).toBe('body/incoterm')
    expect((await no('sales', 'PUT', `/sales/quotes/${quote.id}/terms`, { version: quote.version, incoterm: null, incotermPlace: 'Milano' }, 400)).issues[0].message).toContain('A place without an Incoterm')
    expect((await no('sales', 'PUT', `/sales/quotes/${quote.id}/terms`, { version: quote.version, acceptanceMode: 'SIGN_AND_PAY' }, 400)).issues[0].message).toBe('Sign and pay the deposit: the quote must ask a deposit first.')
    expect((await no('sales', 'PUT', `/sales/quotes/${quote.id}/terms`, { version: quote.version - 1, shipComplete: false }, 409)).code).toBe('conflict')
    await no('viewer', 'PUT', `/sales/quotes/${quote.id}/terms`, { version: quote.version, shipComplete: false }, 403)
    expect((await events('quote.updated', quote.id)).at(-1)?.payload).toMatchObject({ fields: ['incoterm', 'incotermPlace', 'shipComplete'] })
  })
})

describe('a delivery schedule per line (SAL-151)', () => {
  it('plans two deliveries; the rest goes at the promise date; refusals in words', async () => {
    const at = `/sales/quotes/${quote.id}/lines/${lineId}/deliveries`
    const terms = await ok('sales', 'PUT', at, { version: quote.version, deliveries: [{ deliveryDate: addDays(today, 35), sizes: { '52': 2 } }, { deliveryDate: addDays(today, 20), sizes: { '50': 1, '52': 2 }, note: 'Made-up: first half for the season opening' }] })
    quote = { ...quote, version: terms.quoteVersion }
    expect(terms.lines[0].deliveries.map((delivery: Json) => [delivery.deliveryDate, delivery.sizes, delivery.quantity])).toEqual([
      [addDays(today, 20), { '50': 1, '52': 2 }, 3],
      [addDays(today, 35), { '52': 2 }, 2],
    ])
    expect(terms.lines[0].atPromiseDate).toEqual({ '50': 1, '54': 2 })
    expect((await no('sales', 'PUT', at, { version: quote.version, deliveries: [{ deliveryDate: addDays(today, -1), sizes: { '50': 1 } }] }, 400)).issues[0].message).toContain('has passed')
    expect((await no('sales', 'PUT', at, { version: quote.version, deliveries: [{ deliveryDate: addDays(today, 10), sizes: { '54': 3 } }] }, 400)).message).toBe('Size 54: the deliveries bring 3 pieces, the line has 2.')
    expect((await events('quote.lines_changed', quote.id)).at(-1)?.payload).toMatchObject({ change: 'changed', lineId })
  })

  it("refuses a size change the schedule no longer fits (W1's line edit)", async () => {
    const error = await no('sales', 'PATCH', `/sales/quotes/${quote.id}/lines/${lineId}`, { version: quote.version, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }, { size: '54', quantity: 2 }] }, 409)
    expect(error.message).toBe('Line 10: its delivery schedule brings 4 pieces of size 52, the line would have 3. Change the schedule first (Terms & delivery), then the sizes.')
  })
})

describe('validity: EXPIRED after the last day, a reminder before it, a new version revives (SAL-145)', () => {
  it('a new version carries the terms and the deliveries still ahead', async () => {
    await markSent(quote, new Date(Date.now() - 3 * 86_400_000), addDays(today, 30))
    const revised = (await ok('sales', 'POST', `/sales/quotes/${quote.id}/revise`, { version: (await ok('sales', 'GET', `/sales/quotes/${quote.id}`)).quote.version })).quote
    const terms = await ok('sales', 'GET', `/sales/quotes/${revised.id}/terms`)
    expect(terms).toMatchObject({ revision: 2, editable: true, incoterm: 'DAP', incotermPlace: 'Seedville warehouse', shipComplete: true })
    expect(terms.lines[0].deliveries.map((delivery: Json) => delivery.deliveryDate)).toEqual([addDays(today, 20), addDays(today, 35)])
  })

  it('the job marks a sent version past its last day EXPIRED, once; a revise revives it', async () => {
    const ended = await draftQuote()
    await markSent(ended, new Date(Date.now() - 20 * 86_400_000), addDays(today, -1))
    const clock = fixedClock(new Date())
    const first = await runQuoteValidity({ database: h.database, log, clock })
    expect(first.failed).toBe(0)
    const version = await one(`SELECT status, "closedAt" FROM "QuoteVersion" WHERE id = $1`, [ended.current.id])
    expect(version.status).toBe('EXPIRED')
    expect(version.closedAt).not.toBeNull()
    expect((await one(`SELECT status FROM "Quote" WHERE id = $1`, [ended.id])).status).toBe('EXPIRED')
    expect((await events('quote.expired', ended.id)).map((row) => row.payload)).toEqual([{ quoteId: ended.id, versionId: ended.current.id, number: ended.number, revision: 1, validUntil: addDays(today, -1) }])
    const terms = await ok('sales', 'GET', `/sales/quotes/${ended.id}/terms`)
    expect(terms.validity).toMatchObject({ state: 'EXPIRED', expiredAt: expect.any(String) })
    await runQuoteValidity({ database: h.database, log, clock })
    expect((await events('quote.expired', ended.id)).length).toBe(1)
    const revived = (await ok('sales', 'POST', `/sales/quotes/${ended.id}/revise`, { version: (await ok('sales', 'GET', `/sales/quotes/${ended.id}`)).quote.version })).quote
    expect(revived).toMatchObject({ status: 'DRAFT', currentRevision: 2 })
  })

  it('the job reminds the customer three days before the last day, once, on the quote thread, without a link or an amount', async () => {
    const ending = await draftQuote()
    await markSent(ending, new Date(Date.now() - 10 * 86_400_000), addDays(today, 2))
    const clock = fixedClock(new Date())
    const result = await runQuoteValidity({ database: h.database, log, clock })
    expect(result.reminded).toBeGreaterThanOrEqual(1)
    const version = await one(`SELECT status, "reminderSentAt" FROM "QuoteVersion" WHERE id = $1`, [ending.current.id])
    expect(version).toMatchObject({ status: 'SENT', reminderSentAt: expect.any(Date) })
    const [reminded] = await events('quote.reminder_sent', ending.id)
    expect(reminded?.payload).toMatchObject({ quoteId: ending.id, number: ending.number, revision: 1, validUntil: addDays(today, 2) })
    const mail = await one(`SELECT o.status, o.to, o.subject, m."bodyText" FROM "EmailOutbound" o JOIN "Message" m ON m.id = o."messageId" WHERE o.id = $1`, [reminded!.payload.outboundId])
    expect(mail.subject).toBe(`Promemoria: il preventivo ${ending.number} v1 scade presto`)
    expect(mail.to).toEqual([ending.contact.email])
    expect(mail.bodyText).toContain(`valido fino al ${addDays(today, 2).split('-').reverse().join('/')} compreso`)
    expect(mail.bodyText).not.toMatch(/https?:|#token=|€/)
    const terms = await ok('sales', 'GET', `/sales/quotes/${ending.id}/terms`)
    expect(terms.validity).toMatchObject({ state: 'ENDS_SOON', daysLeft: 2, reminderOn: null, reminderSentAt: expect.any(String) })
    await runQuoteValidity({ database: h.database, log, clock })
    expect((await events('quote.reminder_sent', ending.id)).length).toBe(1)
  })
})

describe('the order takes the accepted version’s delivery terms and schedule (SAL-151, SAL-162)', () => {
  it('copies the Incoterm, place, ship complete and each line’s deliveries ahead', async () => {
    const sold = await draftQuote()
    const line = sold.lines[0].id
    let terms = await ok('sales', 'PUT', `/sales/quotes/${sold.id}/terms`, { version: sold.version, incoterm: 'EXW', incotermPlace: 'Seedville', shipComplete: true })
    terms = await ok('sales', 'PUT', `/sales/quotes/${sold.id}/lines/${line}/deliveries`, { version: terms.quoteVersion, deliveries: [{ deliveryDate: addDays(today, 15), sizes: { '50': 2, '52': 2 } }] })
    await markSent(sold, new Date(Date.now() - 86_400_000), addDays(today, 20))
    // Accepted by the office (its QuoteAcceptance in the same statement, as the database asks).
    // Two statements in one query: one transaction, the version ACCEPTED first (the acceptance names an ACCEPTED version).
    await admin(
      `UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now() WHERE id = '${sold.current.id}';
       INSERT INTO "QuoteAcceptance" (id, "tenantId", "versionId", "partyId", channel, "signerName", "documentSha256", "termsVersion", "acceptedAt", "requestId")
       VALUES ('${newId()}', '${T}', '${sold.current.id}', '${P1}', 'OFFICE', 'Made-up Buyer', repeat('b', 64), 'made-up-1', now(), 'made-up')`,
    )
    await admin(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [sold.id])
    const made = await ok('sales', 'POST', '/sales/orders', { quoteVersionId: sold.current.id }, 201)
    const order = await one(`SELECT incoterm, "incotermPlace", "shipComplete" FROM "SalesOrder" WHERE id = $1`, [made.order.id])
    expect(order).toEqual({ incoterm: 'EXW', incotermPlace: 'Seedville', shipComplete: true })
    const deliveries = await admin(`SELECT d."deliveryDate"::text AS day, d."sizeQuantities" AS sizes, d.quantity FROM "SalesOrderLineDelivery" d JOIN "SalesOrderLine" l ON l.id = d."lineId" WHERE l."orderId" = $1`, [made.order.id])
    expect(deliveries).toEqual([{ day: addDays(today, 15), sizes: { '50': 2, '52': 2 }, quantity: 4 }])
    const audit = await one(`SELECT after FROM "AuditLog" WHERE action = 'orders.carryTerms' AND "recordId" = $1`, [made.order.id])
    expect(audit.after).toMatchObject({ incoterm: 'EXW', deliveries: 1, scheduleWaits: null })
  })

  it('an order confirmed by its yes takes the schedule once (sales.orderSchedule); an order with nothing to carry runs no command', async () => {
    const sold = await draftQuote()
    const terms = await ok('sales', 'PUT', `/sales/quotes/${sold.id}/lines/${sold.lines[0].id}/deliveries`, { version: sold.version, deliveries: [{ deliveryDate: addDays(today, 12), sizes: { '54': 2 } }] })
    expect(terms.quoteVersion).toBeGreaterThan(sold.version)
    await markSent(sold, new Date(Date.now() - 86_400_000), addDays(today, 20))
    await admin(
      `UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now() WHERE id = '${sold.current.id}';
       INSERT INTO "QuoteAcceptance" (id, "tenantId", "versionId", "partyId", channel, "signerName", "documentSha256", "termsVersion", "acceptedAt", "requestId")
       VALUES ('${newId()}', '${T}', '${sold.current.id}', '${P1}', 'OFFICE', 'Made-up Buyer', repeat('b', 64), 'made-up-1', now(), 'made-up')`,
    )
    await admin(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [sold.id])
    const made = await ok('sales', 'POST', '/sales/orders', { quoteVersionId: sold.current.id }, 201)
    // As an order that waited for a yes: no schedule of its own yet when it is CONFIRMED.
    await admin(`DELETE FROM "SalesOrderLineDelivery" d USING "SalesOrderLine" l WHERE l.id = d."lineId" AND l."orderId" = $1`, [made.order.id])
    const caller = callerFor(h.database, systemContext(T, `made-up-${run}`))
    expect(await carryScheduleAfterYes(caller, made.order.id)).toEqual({ written: 1 })
    const deliveries = await admin(`SELECT d."deliveryDate"::text AS day, d."sizeQuantities" AS sizes, d.quantity FROM "SalesOrderLineDelivery" d JOIN "SalesOrderLine" l ON l.id = d."lineId" WHERE l."orderId" = $1`, [made.order.id])
    expect(deliveries).toEqual([{ day: addDays(today, 12), sizes: { '54': 2 }, quantity: 2 }])
    // Again (a redelivered event), and an order with nothing to carry: no command, no audit row.
    expect(await carryScheduleAfterYes(caller, made.order.id)).toEqual({ written: 0 })
    const plain = await draftQuote()
    await markSent(plain, new Date(Date.now() - 86_400_000), addDays(today, 20))
    await admin(
      `UPDATE "QuoteVersion" SET status = 'ACCEPTED', "closedAt" = now() WHERE id = '${plain.current.id}';
       INSERT INTO "QuoteAcceptance" (id, "tenantId", "versionId", "partyId", channel, "signerName", "documentSha256", "termsVersion", "acceptedAt", "requestId")
       VALUES ('${newId()}', '${T}', '${plain.current.id}', '${P1}', 'OFFICE', 'Made-up Buyer', repeat('b', 64), 'made-up-1', now(), 'made-up')`,
    )
    await admin(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [plain.id])
    const bare = await ok('sales', 'POST', '/sales/orders', { quoteVersionId: plain.current.id }, 201)
    expect(await carryScheduleAfterYes(caller, bare.order.id)).toEqual({ written: 0 })
    const audits = await admin<{ recordId: string; after: Json }>(`SELECT "recordId", after FROM "AuditLog" WHERE action = 'orders.carrySchedule' AND "recordId" = ANY($1::uuid[]) ORDER BY at, id`, [[made.order.id, bare.order.id]])
    expect(audits).toEqual([{ recordId: made.order.id, after: expect.objectContaining({ deliveries: 1, passed: [] }) }])
  })
})
