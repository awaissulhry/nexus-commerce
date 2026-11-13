import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * Sales reports (B-W2b-348; SAL-105, SAL-106, SAL-458; design sales.reports SCR-250 and Sales › Quotes sec quotes.speed) through
 * the app's real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is
 * real), tenant A from EVERY seed. The test's own world is company B (the seeds sell nothing there): orders, returns, quotes and
 * shipments copied from seed rows with made-up numbers and dates (test data past the guards: their states are other steps'
 * routes). Sessions hold the role templates' grants on company B. The clock is 30 November 2026 (a Monday): the default period
 * is November 2026. Every name and number is made up.
 *
 *   O1  SEED-C1, confirmed 3 Nov, season of company B: JKT-01 10 pieces (50:6, 52:4) 1,000.00, promised 10 Dec (size 52 promised
 *       20 Dec in the promise history), and a tooling fee 50.00; 2 pieces of size 50 shipped on 15 Nov
 *   O2  SEED-C2, shipped, 20 Nov: JKT-02 20 pieces 2,000.00 (shipped 21 Nov)
 *   O3  waiting for a yes (10 Nov), O4 cancelled (12 Nov), O7 a return's replacement (5 Nov): never intake
 *   O5  SEED-C1, confirmed 15 Oct: JKT-01 5 pieces 500.00 promised 20 Nov (late now)
 *   O6  split off O5 on 25 Nov (dated 25 Nov): JKT-02 3 pieces 300.00, no promise — booked on 15 Oct with O5
 *   R1  SEED-C2 asked 22 Nov: 2 × size 50 wrong size, 1 × size 52 defect (credit 100.00); R2 rejected; R3 asked in October
 *   Q1  from an inquiry (2 Nov 07:00), sent 3 Nov, accepted 5 Nov (3,000.00); Q2 sent 10 Nov, declined 12 Nov; Q3 first sent in
 *       October, expired 15 Nov
 * Run with `node scripts/factory/run-pg-tests.mjs modules/insights/sales-reports/`.
 */

type Json = Record<string, any>

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'sales-reports-348'
const sid = (key: string) => seedUuid(NS, key)
const T = sid('tenant')
const COMPANY_A = sid('company:A')
const COMPANY_B = sid('company:B')
const NOW = new Date('2026-11-30T15:00:00.000Z')

const x = Object.fromEntries(['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'l1', 'l1f', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'r1', 'r2', 'r3', 'q1', 'q2', 'q3', 's1', 's2'].map((key) => [key, newId()])) as Record<string, string>

let h: Harness
let app: FastifyInstance
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!

/** A copy of a seed row with some columns changed (test data past the guards: replica mode, one connection). */
async function copy(table: string, sourceId: string, changes: Record<string, unknown>): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(`CREATE TEMP TABLE _copy AS SELECT * FROM "${table}" WHERE id = $1`, [sourceId])
    const keys = Object.keys(changes)
    await admin(`UPDATE _copy SET ${keys.map((key, index) => `"${key}" = $${index + 1}`).join(', ')}`, Object.values(changes))
    await admin(`INSERT INTO "${table}" SELECT * FROM _copy`)
  } finally {
    await admin('DROP TABLE IF EXISTS _copy')
    await admin('SET session_replication_role = DEFAULT')
  }
}

function grantsOf(role: string, extra: string[] = [], without: string[] = []): Grant[] {
  const template = templateOf(role)!
  const permissions = [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission), ...extra].filter((name) => !without.includes(name)) as Permission[]
  return [{ permissions, companies: 'all', sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, () => SessionContext> = {}
const session = (grants: Grant[], companyId = COMPANY_B) => (): SessionContext => ({ audience: 'office', tenantId: T, actorId: newId(), companyId, grants }) as SessionContext

const call = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': who } })
async function ok(who: string, url: string): Promise<Json> {
  const response = await call(who, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
async function refused(who: string, url: string, status: number): Promise<Json> {
  const response = await call(who, url)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []

beforeAll(async () => {
  h = await startHarness('sales_reports_w2b348')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const id = async (sql: string, values: unknown[]) => (await one<{ id: string }>(sql, [T, ...values])).id
  const c1 = await id(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = $2`, ['SEED-C1'])
  const c2 = await id(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND code = $2`, ['SEED-C2'])
  const siteB = await id(`SELECT id FROM "Site" WHERE "tenantId" = $1 AND "companyId" = $2 ORDER BY code LIMIT 1`, [COMPANY_B])
  const seasonB = await id(`SELECT id FROM "Season" WHERE "tenantId" = $1 AND "companyId" = $2 ORDER BY code LIMIT 1`, [COMPANY_B])
  const srcOrder = await id(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2`, ['SEED-SO-0001'])
  const srcLine = await one<{ id: string; styleId: string; colourwayId: string }>(`SELECT id, "styleId", "colourwayId" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq LIMIT 1`, [srcOrder])
  const srcSize = await id(`SELECT id FROM "SalesOrderLineSize" WHERE "tenantId" = $1 AND "lineId" = $2 ORDER BY size LIMIT 1`, [srcLine.id])
  const jkt02 = await one<{ styleId: string; colourwayId: string }>(`SELECT s.id AS "styleId", c.id AS "colourwayId" FROM "Style" s JOIN "Colourway" c ON c."styleId" = s.id WHERE s."tenantId" = $1 AND s.code = 'SEED-JKT-02' ORDER BY c.code LIMIT 1`, [T])
  const srcRma = await id(`SELECT id FROM "ReturnAuthorisation" WHERE "tenantId" = $1 AND number = $2`, ['SEED-RMA-0002'])
  const srcRmaLine = await id(`SELECT id FROM "ReturnLine" WHERE "tenantId" = $1 AND "returnId" = $2 ORDER BY seq LIMIT 1`, [srcRma])
  const srcQuote = await id(`SELECT id FROM "Quote" WHERE "tenantId" = $1 AND number = $2`, ['SEED-Q-0001'])
  const srcVersion = await id(`SELECT id FROM "QuoteVersion" WHERE "tenantId" = $1 AND "quoteId" = $2 ORDER BY revision LIMIT 1`, [srcQuote])
  const srcInquiry = await id(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 ORDER BY number LIMIT 1`, [])
  const srcShipment = await id(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 ORDER BY number LIMIT 1`, [])
  const srcShipmentLine = await id(`SELECT id FROM "ShipmentLine" WHERE "tenantId" = $1 AND "shipmentId" = $2 LIMIT 1`, [srcShipment])

  const order = async (orderId: string, number: string, partyId: string, status: string, orderDate: string, netAmount: number, extra: Record<string, unknown> = {}) =>
    copy('SalesOrder', srcOrder, { id: orderId, number, companyId: COMPANY_B, partyId, status, orderDate, netAmount, promiseDate: null, originalPromiseDate: null, seasonId: null, quoteVersionId: null, backlogRank: null, closedAt: null, priorityLevel: 'NORMAL', ...extra })
  const line = async (lineId: string, orderId: string, partyId: string, seq: number, style: { styleId: string; colourwayId: string }, sizes: Record<string, number>, netAmount: number, extra: Record<string, unknown> = {}) => {
    const quantity = Object.values(sizes).reduce((sum, value) => sum + value, 0)
    await copy('SalesOrderLine', srcLine.id, { id: lineId, orderId, companyId: COMPANY_B, partyId, seq, kind: 'SIZE_GRID', feeKind: null, styleId: style.styleId, colourwayId: style.colourwayId, styleRevisionId: null, quoteLineId: null, quantity, netAmount, promiseDate: null, siteId: null, closedShortAt: null, closedShortQuantity: null, ...extra })
    for (const [size, count] of Object.entries(sizes)) await copy('SalesOrderLineSize', srcSize, { id: newId(), lineId, partyId, size, quantity: count })
  }
  const jkt01 = { styleId: srcLine.styleId, colourwayId: srcLine.colourwayId }

  await order(x.o1!, 'T348-SO-1', c1, 'CONFIRMED', '2026-11-03', 105_000, { promiseDate: '2026-12-10', seasonId: seasonB })
  await line(x.l1!, x.o1!, c1, 10, jkt01, { '50': 6, '52': 4 }, 100_000)
  await copy('SalesOrderLine', srcLine.id, { id: x.l1f, orderId: x.o1, companyId: COMPANY_B, partyId: c1, seq: 20, kind: 'FEE', feeKind: 'TOOLING', styleRevisionId: null, quoteLineId: null, quantity: 1, netAmount: 5_000, promiseDate: null, siteId: null, closedShortAt: null })
  await admin('SET session_replication_role = replica')
  await admin(`INSERT INTO "PromiseRecord" (id, "tenantId", "salesOrderLineId", "partyId", size, "promisedDate", kind, "promisedById", "promisedAt") VALUES ($1, $2, $3, $4, '52', '2026-12-20', 'FIRST', $5, $6)`, [newId(), T, x.l1, c1, newId(), new Date('2026-11-20T09:00:00Z')])
  await admin('SET session_replication_role = DEFAULT')
  await order(x.o2!, 'T348-SO-2', c2, 'SHIPPED', '2026-11-20', 200_000)
  await line(x.l2!, x.o2!, c2, 10, jkt02, { '50': 10, '52': 10 }, 200_000)
  await order(x.o3!, 'T348-SO-3', c1, 'PENDING_APPROVAL', '2026-11-10', 70_000)
  await line(x.l3!, x.o3!, c1, 10, jkt01, { '50': 7 }, 70_000)
  await order(x.o4!, 'T348-SO-4', c1, 'CANCELLED', '2026-11-12', 40_000)
  await line(x.l4!, x.o4!, c1, 10, jkt01, { '50': 4 }, 40_000)
  await order(x.o5!, 'T348-SO-5', c1, 'CONFIRMED', '2026-10-15', 50_000, { promiseDate: '2026-11-20' })
  await line(x.l5!, x.o5!, c1, 10, jkt01, { '52': 5 }, 50_000)
  await order(x.o6!, 'T348-SO-6', c1, 'CONFIRMED', '2026-11-25', 30_000)
  await line(x.l6!, x.o6!, c1, 10, jkt02, { '54': 3 }, 30_000)
  await admin(`INSERT INTO "AuditLog" (id, "tenantId", "companyId", at, audience, "actorId", action, "recordType", "recordId", after, "requestId") VALUES ($1, $2, $3, $4, 'OFFICE', $5, 'orders.splitOff', 'SalesOrder', $6, $7, 'test-348')`, [newId(), T, COMPANY_B, new Date('2026-11-25T10:00:00Z'), newId(), x.o6, JSON.stringify({ number: 'T348-SO-6', splitFrom: x.o5, splitFromNumber: 'T348-SO-5' })])
  await order(x.o7!, 'T348-SO-7', c2, 'SHIPPED', '2026-11-05', 10_000)
  await line(x.l7!, x.o7!, c2, 10, jkt01, { '50': 1 }, 10_000)

  const rmaCols = { companyId: COMPANY_B, siteId: siteB, partyId: c2, salesOrderId: null, closedAt: null, policyId: null, scanCode: null, replacementOrderId: null }
  await copy('ReturnAuthorisation', srcRma, { ...rmaCols, id: x.r1, number: 'T348-RMA-1', status: 'AUTHORISED', requestedAt: new Date('2026-11-22T10:00:00Z'), replacementOrderId: x.o7 })
  await copy('ReturnAuthorisation', srcRma, { ...rmaCols, id: x.r2, number: 'T348-RMA-2', status: 'REJECTED', requestedAt: new Date('2026-11-23T10:00:00Z') })
  await copy('ReturnAuthorisation', srcRma, { ...rmaCols, id: x.r3, number: 'T348-RMA-3', status: 'AUTHORISED', requestedAt: new Date('2026-10-05T10:00:00Z') })
  const rmaLine = (returnId: string, seq: number, size: string, quantity: number, reasonCode: string, creditAmount: number | null) =>
    copy('ReturnLine', srcRmaLine, { id: newId(), returnId, siteId: siteB, partyId: c2, seq, salesOrderLineId: x.l2, invoiceLineId: null, size, quantity, reasonCode, creditAmount, receiptId: null, replacementLineId: null, parentLineId: null, feeRuleId: null, feeAmount: null, garmentSerial: null, garmentBatch: null })
  await rmaLine(x.r1!, 10, '50', 2, 'WRONG_SIZE', null)
  await rmaLine(x.r1!, 20, '52', 1, 'DEFECT', 10_000)
  await rmaLine(x.r2!, 10, '50', 4, 'DEFECT', null)
  await rmaLine(x.r3!, 10, '52', 6, 'DEFECT', null)

  await copy('Shipment', srcShipment, { id: x.s1, number: 'T348-SH-1', companyId: COMPANY_B, siteId: siteB, partyId: c1, salesOrderId: x.o1, status: 'SHIPPED', shippedAt: new Date('2026-11-15T10:00:00Z') })
  await copy('ShipmentLine', srcShipmentLine, { id: newId(), siteId: siteB, partyId: c1, shipmentId: x.s1, salesOrderLineId: x.l1, size: '50', quantity: 2, parcelId: null })
  await copy('Shipment', srcShipment, { id: x.s2, number: 'T348-SH-2', companyId: COMPANY_B, siteId: siteB, partyId: c2, salesOrderId: x.o2, status: 'DELIVERED', shippedAt: new Date('2026-11-21T10:00:00Z') })
  await copy('ShipmentLine', srcShipmentLine, { id: newId(), siteId: siteB, partyId: c2, shipmentId: x.s2, salesOrderLineId: x.l2, size: '50', quantity: 20, parcelId: null })

  const quote = async (quoteId: string, number: string, status: string, createdAt: Date, sentAt: Date, closedAt: Date | null, netAmount: number) => {
    await copy('Quote', srcQuote, { id: quoteId, number, companyId: COMPANY_B, partyId: c1, status, createdAt, templateId: null, contactId: null })
    await copy('QuoteVersion', srcVersion, { id: newId(), quoteId, partyId: c1, revision: 1, status, sentAt, closedAt, netAmount, currency: 'EUR', seasonId: null, priceListVersionId: null, taxIdentityId: null, billToAddressId: null, shipToAddressId: null, paymentTermsId: null })
  }
  await quote(x.q1!, 'T348-Q-1', 'ACCEPTED', new Date('2026-11-02T08:00:00Z'), new Date('2026-11-03T10:00:00Z'), new Date('2026-11-05T10:00:00Z'), 300_000)
  await quote(x.q2!, 'T348-Q-2', 'DECLINED', new Date('2026-11-10T08:00:00Z'), new Date('2026-11-10T14:00:00Z'), new Date('2026-11-12T14:00:00Z'), 100_000)
  await quote(x.q3!, 'T348-Q-3', 'EXPIRED', new Date('2026-10-19T08:00:00Z'), new Date('2026-10-20T10:00:00Z'), new Date('2026-11-15T03:00:00Z'), 80_000)
  await copy('Inquiry', srcInquiry, { id: newId(), number: 'T348-INQ-1', companyId: COMPANY_B, quoteId: x.q1, receivedAt: new Date('2026-11-02T07:00:00Z'), partyId: c1, contactId: null, status: 'QUOTED', sourceEmailId: null, assigneeId: null })

  SESSIONS.sales = session(grantsOf('sales'))
  SESSIONS.manager = session(grantsOf('production_manager'))
  SESSIONS.planner = session(grantsOf('planner'))
  SESSIONS.blind = session(grantsOf('sales', [], ['orders.view', 'sales.returns.view']))
  SESSIONS.quotesOnly = session(grantsOf('sales', [], ['sales.reports.view']))
  SESSIONS.companyA = session(grantsOf('sales'), COMPANY_A)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
}, 600_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await h?.close()
}, 60_000)

describe('order intake (SAL-105)', () => {
  it('counts the confirmed orders booked in November, by week, at their value now; never waiting, cancelled or a replacement', async () => {
    const answer = await ok('sales', '/sales/reports/intake')
    expect(answer).toMatchObject({ from: '2026-11-01', to: '2026-11-30', today: '2026-11-30', by: 'week', split: 'none', companyCurrency: 'EUR', sight: { orders: true, values: true } })
    expect(answer.all).toMatchObject({ orders: 2, pieces: 30, value: 305_000, currency: 'EUR', mixedCurrencies: false })
    expect(answer.orders.map((order: Json) => order.number)).toEqual(['T348-SO-2', 'T348-SO-1'])
    const weeks = Object.fromEntries((answer.buckets as Json[]).map((bucket) => [bucket.key, bucket.figures.pieces]))
    expect(weeks).toMatchObject({ '2026-W45': 10, '2026-W46': 0, '2026-W47': 20, '2026-W49': 0 })
    expect(answer.orders.find((order: Json) => order.number === 'T348-SO-1')).toMatchObject({ bucket: '2026-W45', pieces: 10, value: 105_000, season: { id: expect.any(String) }, splitOff: false })
  })

  it('splits by style (fee lines apart) and season; months; an order split off later counts on its first order’s day', async () => {
    const byStyle = await ok('sales', '/sales/reports/intake?split=style')
    expect(byStyle.groups.map((group: Json) => [group.code ?? group.key, group.figures.pieces, group.figures.value])).toEqual([
      ['SEED-JKT-02', 20, 200_000],
      ['SEED-JKT-01', 10, 100_000],
      ['fees', 0, 5_000],
    ])
    const bySeason = await ok('sales', '/sales/reports/intake?split=season&by=month')
    expect(bySeason.buckets.map((bucket: Json) => bucket.key)).toEqual(['2026-11'])
    expect(bySeason.groups.map((group: Json) => [group.key === 'none' ? 'none' : 'season', group.figures.orders])).toEqual([
      ['none', 1],
      ['season', 1],
    ])
    const october = await ok('sales', '/sales/reports/intake?from=2026-10-01&to=2026-10-31')
    expect(october.orders.map((order: Json) => [order.number, order.bookedOn, order.splitOff])).toEqual([
      ['T348-SO-6', '2026-10-15', true],
      ['T348-SO-5', '2026-10-15', false],
    ])
    expect(october.all).toMatchObject({ orders: 2, pieces: 8, value: 80_000 })
  })
})

describe('the backlog by promise week (SAL-106)', () => {
  it('open pieces at each size’s promise now (the history first), late before today, by customer with horizons', async () => {
    const answer = await ok('sales', '/sales/reports/backlog')
    expect(answer).toMatchObject({ today: '2026-11-30', by: 'customer' })
    // O1: size 50 6 − 2 shipped = 4 (10 Dec), size 52 4 (re-promised 20 Dec); O5 5 late (20 Nov); O6 3 with no promise.
    expect(answer.all).toMatchObject({ orders: 3, lines: 3, pieces: 16, late: 5, value: 40_000 + 40_000 + 50_000 + 30_000 })
    expect(answer.weeks.map((week: Json) => [week.key, week.past, week.current, week.figures.pieces])).toEqual([
      ['2026-W47', true, false, 5],
      ['2026-W48', true, false, 0],
      ['2026-W49', false, true, 0],
      ['2026-W50', false, false, 4],
      ['2026-W51', false, false, 4],
      ['NONE', false, false, 3],
    ])
    const sizes = (answer.lines as Json[]).filter((row) => row.number === 'T348-SO-1').map((row) => [row.size, row.open, row.promise, row.promiseSource, row.horizon])
    expect(sizes).toEqual([
      ['50', 4, '2026-12-10', 'TYPED', 'next4'],
      ['52', 4, '2026-12-20', 'RECORD', 'next4'],
    ])
    expect(answer.groups).toHaveLength(1)
    expect(answer.groups[0]).toMatchObject({ code: 'SEED-C1', horizons: { late: 5, thisWeek: 0, next4: 8, later: 0, none: 3 } })
    const byStyle = await ok('sales', '/sales/reports/backlog?by=style')
    expect(byStyle.groups.map((group: Json) => [group.code, group.figures.pieces])).toEqual([
      ['SEED-JKT-01', 13],
      ['SEED-JKT-02', 3],
    ])
  })
})

describe('return reasons (SAL-458)', () => {
  it('the lines asked back in November by reason, style, size, customer; the return rate over the pieces shipped', async () => {
    const answer = await ok('sales', '/sales/reports/returns')
    expect(answer.all).toMatchObject({ returns: 1, lines: 2, pieces: 3, value: 10_000 })
    expect(answer.shipped).toBe(22)
    expect(answer.returnRatePct).toBe('13.6')
    expect(answer.reasons.map((reason: Json) => [reason.key, reason.figures.pieces, reason.words?.en])).toEqual([
      ['WRONG_SIZE', 2, 'Wrong size'],
      ['DEFECT', 1, 'Defect'],
    ])
    expect(answer.styles.map((group: Json) => [group.code, group.figures.pieces])).toEqual([['SEED-JKT-02', 3]])
    expect(answer.sizes.map((group: Json) => group.key)).toEqual(['50', '52'])
    expect(answer.customers.map((group: Json) => group.code)).toEqual(['SEED-C2'])
    expect(answer.heatmap).toMatchObject({ sizes: ['50', '52'], cells: [[2, 1]] })
    expect(answer.lines.map((row: Json) => [row.number, row.seq, row.reason, row.size])).toEqual([
      ['T348-RMA-1', 10, 'WRONG_SIZE', '50'],
      ['T348-RMA-1', 20, 'DEFECT', '52'],
    ])
  })
})

describe('quote speed and the headline', () => {
  it('first sends of the period, decisions (expired apart), win rate, value won; quotes.view alone reads it', async () => {
    for (const who of ['sales', 'quotesOnly']) {
      const speed = await ok(who, '/sales/reports/quote-speed')
      expect(speed).toMatchObject({ answered: 2, fromInquiries: 1, accepted: 1, declined: 1, expired: 1, winRatePct: '50.0', medianDecisionHours: 48, won: { value: 300_000 } })
      expect(speed.medianAnswerMinutes).toBeGreaterThan(0)
    }
  })

  it('the five numbers; null where the records are not in the role', async () => {
    const answer = await ok('sales', '/sales/reports/headline')
    expect(answer.intake).toMatchObject({ orders: 2, pieces: 30, value: 305_000 })
    expect(answer.backlog).toMatchObject({ pieces: 16, late: 5 })
    expect(answer.quotes).toMatchObject({ winRatePct: '50.0', answered: 2 })
    expect(answer.returns).toMatchObject({ pieces: 3, shipped: 22, returnRatePct: '13.6' })
    const blind = await ok('blind', '/sales/reports/headline')
    expect(blind).toMatchObject({ sight: { orders: false, returns: false, quotes: true }, intake: null, backlog: null, returns: null })
    expect(blind.quotes.answered).toBe(2)
  })
})

describe('rights and refusals', () => {
  it('without the price grain: pieces and counts, never an amount; no person in any answer', async () => {
    for (const path of ['headline', 'intake?split=customer', 'backlog', 'returns']) {
      const answer = await ok('manager', `/sales/reports/${path}`)
      expect(answer.sight.values, path).toBe(false)
      const keys = keysOf(answer)
      expect(keys, path).not.toContain('value')
      expect(keys, path).not.toContain('credited')
    }
    const manager = await ok('manager', '/sales/reports/intake')
    expect(manager.all).toMatchObject({ orders: 2, pieces: 30 })
    for (const path of ['headline', 'intake', 'backlog', 'returns', 'quote-speed']) {
      const keys = keysOf(await ok('sales', `/sales/reports/${path}`))
      for (const name of ['createdById', 'assigneeId', 'actorId', 'sentById', 'decidedById', 'ownerId', 'email']) expect(keys, `${path} ${name}`).not.toContain(name)
    }
  })

  it('refuses in words: no sales reports in the role, quotes not in the role, a period after today, an unknown key; company A sees none of company B', async () => {
    expect((await refused('planner', '/sales/reports/intake', 403)).code).toBeDefined()
    await refused('planner', '/sales/reports/quote-speed', 403)
    await refused('quotesOnly', '/sales/reports/headline', 403)
    expect((await refused('sales', '/sales/reports/intake?to=2026-12-01', 400)).message).toMatch(/after today/)
    await refused('sales', '/sales/reports/backlog?from=2026-11-01', 400)
    await refused('sales', '/sales/reports/intake?split=colour', 400)
    const companyA = await ok('companyA', '/sales/reports/intake')
    expect(companyA.orders.map((order: Json) => order.number)).not.toContain('T348-SO-1')
  })
})
