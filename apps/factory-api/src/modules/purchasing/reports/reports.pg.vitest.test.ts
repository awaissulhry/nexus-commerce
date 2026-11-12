import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { runAlertEvaluation } from '../../../platform/alerts/engine'
import { startInventoryFixture, type InventoryFixture } from '../../inventory/ledger/testing/fixture'

/**
 * Purchasing reports and supply alerts (B-W2b-350; design purchasing.reports SCR-255; SCM-165, SCM-174) through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security is real), on the
 * inventory module's made-up world (company A with sites A1 and A2, company A2 with site C1). The orders are written as test
 * data past the guards (their states, sends and receipts are other steps' routes). The clock is 30 November 2026: the default
 * period is November 2026.
 *
 *   O1  supplier S1, A1, confirmed, first sent 3 Nov: leather 100 ft² at 4.20 (420.00; needed 20 Dec, confirmed for 3 Jan) and a
 *       cancelled lining line (never spend)
 *   O2  S1, A1, first sent 20 Oct, sent again (revision 2) on 5 Nov: 40.00 — October's spend, not November's
 *   O3  S2, A2, partly received, first sent 10 Nov: fabric 20 m² at 12.00 closed short after 5 m² came → 60.00
 *   O4  S2, A1, a SAMPLE order sent 12 Nov: 20.00 — apart, never production spend
 *   O5  S1, A1, in USD at 1.0850, first sent 15 Nov: protectors 108.50 USD → 100.00 EUR (the rate of the order)
 *   O6  a draft, O7 a cancelled order, O8 company A2's order: never in company A's November spend
 *   O9  S2, A1, sent 20 Nov with no revision row kept (an order from before revisions): its own send → 10.00
 *
 * Supply alerts through the real engine (runAlertEvaluation): O1 confirmed 14 days later than needed (PO_CONFIRMED_LATE); S2
 * put ON HOLD on 28 November (SUPPLIER_STATUS_CHANGED), S3 blocked in October (past the rule's 7 days: none); the alert of S2 is
 * seen only with parties.view, and clears when S2 is approved again.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/reports/`.
 */

type Json = Record<string, any>
const NOW = new Date('2026-11-30T15:00:00.000Z')
let f: InventoryFixture
let app: FastifyInstance
let ids: InventoryFixture['ids']
const QUIET = { info: () => undefined, warn: () => undefined, error: () => undefined } as never
const x = {
  s1: newId(),
  s2: newId(),
  s3: newId(),
  o1: newId(),
  o2: newId(),
  o3: newId(),
  o4: newId(),
  o5: newId(),
  o6: newId(),
  o7: newId(),
  o8: newId(),
  o9: newId(),
  l1: newId(),
  l1b: newId(),
  l2: newId(),
  l3: newId(),
  l4: newId(),
  l5: newId(),
  l6: newId(),
  l7: newId(),
  l8: newId(),
  l9: newId(),
  receipt: newId(),
}

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites, parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {}
const office = (permissions: string[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all') => (): SessionContext =>
  ({ audience: 'office', tenantId: ids.tenantA, actorId: newId(), companyId: ids.companyA, grants: [grant(permissions, companies, sites)] }) as SessionContext
const READER = ['purchasing.reports.view', 'purchasing.view']

const call = (session: string, url: string) => app.inject({ method: 'GET', url, headers: { 'x-test-session': session } })
async function ok(session: string, url: string): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(200)
  return response.json() as Json
}
async function refused(session: string, url: string, status: number): Promise<Json> {
  const response = await call(session, url)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []

const at = (date: string, hour = 9) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`)

/** Test data past the guards (replica mode: no trigger runs) on the admin login's one connection. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await f.admin('SET session_replication_role = replica')
  try {
    await f.admin(sql, values)
  } finally {
    await f.admin('SET session_replication_role = DEFAULT')
  }
}

interface OrderData {
  id: string
  number: string
  partyId: string
  siteId?: string
  companyId?: string
  status: string
  kind?: 'STANDARD' | 'SAMPLE'
  currency?: string
  rate?: string
  companyNet?: number
  /** Revision 1's send (null: no revision kept), the order's latest send. */
  first: Date | null
  sent: Date | null
  lines: { id: string; seq: number; itemId: string; quantity: string; uom: string; unitPrice: string; net: number; need: string; confirmed?: string; cancelled?: boolean; closedShort?: boolean }[]
}

async function order(data: OrderData): Promise<void> {
  const siteId = data.siteId ?? ids.siteA1
  const companyId = data.companyId ?? ids.companyA
  const net = data.lines.filter((line) => !line.cancelled).reduce((sum, line) => sum + line.net, 0)
  await force(
    `INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", status, kind, currency, "rateAtOrder", "companyNetAmount", "netAmount", "sentAt", "cancelledAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"PurchaseOrderStatus", $9::"PurchaseOrderKind", $10, $11, $12, $13, $14, $15)`,
    [data.id, ids.tenantA, companyId, siteId, data.number, data.partyId, (data.sent ?? at('2026-11-01')).toISOString().slice(0, 10), data.status, data.kind ?? 'STANDARD', data.currency ?? 'EUR', data.rate ?? null, data.companyNet ?? null, net, data.sent, data.status === 'CANCELLED' ? at('2026-11-06') : null],
  )
  for (const line of data.lines) {
    await force(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "confirmedQuantity", "confirmedDate", "cancelledAt", "closedShortAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::"Uom", $8, $10, $11, $12, $13, $14, $15, $16)`,
      [line.id, ids.tenantA, data.id, data.partyId, siteId, line.seq, line.itemId, line.quantity, line.uom, line.unitPrice, line.net, line.need, line.confirmed ? line.quantity : null, line.confirmed ?? null, line.cancelled ? at('2026-11-04') : null, line.closedShort ? at('2026-11-25') : null],
    )
  }
  if (data.first) {
    await force(`INSERT INTO "PurchaseOrderRevision" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", revision, "sentAt", after, "afterPrices") VALUES ($1, $2, $3, $4, $5, 1, $6, '{}', '{}')`, [newId(), ids.tenantA, data.id, data.partyId, siteId, data.first])
    if (data.sent && data.sent.getTime() !== data.first.getTime()) {
      await force(`INSERT INTO "PurchaseOrderRevision" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", revision, "sentAt", after, "afterPrices") VALUES ($1, $2, $3, $4, $5, 2, $6, '{}', '{}')`, [newId(), ids.tenantA, data.id, data.partyId, siteId, data.sent])
    }
  }
}

beforeAll(async () => {
  f = await startInventoryFixture('purchasing_reports')
  ids = f.ids
  Object.assign(SESSIONS, {
    buyer: office([...READER, 'money.cost']),
    planner: office(READER),
    reportsOnly: office(['purchasing.reports.view']),
    noRight: office(['purchasing.view', 'money.cost']),
    otherCompany: office([...READER, 'money.cost'], [ids.companyA2]),
    alertsBuyer: office(['alerts.view', 'purchasing.view', 'parties.view']),
    alertsNoParties: office(['alerts.view', 'purchasing.view']),
  })
  for (const [id, code, name, status, changed] of [
    [x.s1, 'FORN-350-A', 'Conceria Inventata S.r.l.', 'APPROVED', at('2026-09-01')],
    [x.s2, 'FORN-350-B', 'Tessitura Inventata S.r.l.', 'ON_HOLD', at('2026-11-28')],
    [x.s3, 'FORN-350-C', 'Minuteria Inventata S.r.l.', 'BLOCKED', at('2026-10-01')],
  ] as const) {
    await force(
      `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, "supplierStatus", "supplierStatusReason", "supplierStatusChangedAt") VALUES ($1, $2, $3, $4, 'ORGANISATION', $5, '{SUPPLIER}', $6::"SupplierStatus", $7, $8)`,
      [id, ids.tenantA, ids.companyA, code, name, status, status === 'APPROVED' ? null : 'Made-up reason for the test.', changed],
    )
  }
  await order({
    id: x.o1,
    number: 'PO-350-1',
    partyId: x.s1,
    status: 'CONFIRMED',
    first: at('2026-11-03'),
    sent: at('2026-11-03'),
    lines: [
      { id: x.l1, seq: 10, itemId: ids.leather, quantity: '100', uom: 'FT2', unitPrice: '4.2', net: 42_000, need: '2026-12-20', confirmed: '2027-01-03' },
      { id: x.l1b, seq: 20, itemId: ids.lining, quantity: '50', uom: 'M', unitPrice: '3', net: 15_000, need: '2026-12-20', cancelled: true },
    ],
  })
  await order({ id: x.o2, number: 'PO-350-2', partyId: x.s1, status: 'SENT', first: at('2026-10-20'), sent: at('2026-11-05'), lines: [{ id: x.l2, seq: 10, itemId: ids.leather, quantity: '10', uom: 'FT2', unitPrice: '4', net: 4_000, need: '2026-12-15' }] })
  await order({
    id: x.o3,
    number: 'PO-350-3',
    partyId: x.s2,
    siteId: ids.siteA2,
    status: 'PARTLY_RECEIVED',
    first: at('2026-11-10'),
    sent: at('2026-11-10'),
    lines: [{ id: x.l3, seq: 10, itemId: ids.fabric, quantity: '20', uom: 'M2', unitPrice: '12', net: 24_000, need: '2026-11-25', confirmed: '2026-11-25', closedShort: true }],
  })
  await force(`INSERT INTO "GoodsReceipt" (id, "tenantId", "companyId", "siteId", number, "supplierId", "purchaseOrderId", kind, "receivedAt", status, "postedAt") VALUES ($1, $2, $3, $4, 'GR-350-1', $5, $6, 'STANDARD', $7, 'POSTED', $7)`, [x.receipt, ids.tenantA, ids.companyA, ids.siteA2, x.s2, x.o3, at('2026-11-24')])
  await force(`INSERT INTO "GoodsReceiptLine" (id, "tenantId", "siteId", "receiptId", seq, "purchaseOrderLineId", "itemId", quantity, uom, "baseQuantity") VALUES ($1, $2, $3, $4, 1, $5, $6, 5, 'M2', 5)`, [newId(), ids.tenantA, ids.siteA2, x.receipt, x.l3, ids.fabric])
  await order({ id: x.o4, number: 'PO-350-4', partyId: x.s2, status: 'SENT', kind: 'SAMPLE', first: at('2026-11-12'), sent: at('2026-11-12'), lines: [{ id: x.l4, seq: 10, itemId: ids.fabric, quantity: '2', uom: 'M2', unitPrice: '10', net: 2_000, need: '2026-12-10' }] })
  await order({
    id: x.o5,
    number: 'PO-350-5',
    partyId: x.s1,
    status: 'CONFIRMED',
    currency: 'USD',
    rate: '1.085',
    companyNet: 10_000,
    first: at('2026-11-15'),
    sent: at('2026-11-15'),
    lines: [{ id: x.l5, seq: 10, itemId: ids.protector, quantity: '10', uom: 'PCS', unitPrice: '10.85', net: 10_850, need: '2026-12-10', confirmed: '2026-12-10' }],
  })
  await order({ id: x.o6, number: 'PO-350-6', partyId: x.s1, status: 'DRAFT', first: null, sent: null, lines: [{ id: x.l6, seq: 10, itemId: ids.leather, quantity: '1000', uom: 'FT2', unitPrice: '4', net: 400_000, need: '2026-12-30' }] })
  await order({ id: x.o7, number: 'PO-350-7', partyId: x.s1, status: 'CANCELLED', first: at('2026-11-04'), sent: at('2026-11-04'), lines: [{ id: x.l7, seq: 10, itemId: ids.leather, quantity: '50', uom: 'FT2', unitPrice: '4', net: 20_000, need: '2026-12-30' }] })
  await order({ id: x.o8, number: 'PO-350-8', partyId: x.s1, companyId: ids.companyA2, siteId: ids.siteC1, status: 'SENT', first: at('2026-11-06'), sent: at('2026-11-06'), lines: [{ id: x.l8, seq: 10, itemId: ids.leather, quantity: '10', uom: 'FT2', unitPrice: '5', net: 5_000, need: '2026-12-30' }] })
  await order({ id: x.o9, number: 'PO-350-9', partyId: x.s2, status: 'SENT', first: null, sent: at('2026-11-20'), lines: [{ id: x.l9, seq: 10, itemId: ids.thread, quantity: '10', uom: 'CONE', unitPrice: '1', net: 1_000, need: '2026-12-30' }] })

  vi.useFakeTimers({ toFake: ['Date'], now: NOW })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: f.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null), logger: false },
  )
}, 900_000)

afterAll(async () => {
  vi.useRealTimers()
  await app?.close()
  await f?.close()
}, 60_000)

const group = (answer: Json, key: string): Json => (answer.groups as Json[]).find((entry) => entry.key === key)!

describe('spend (sec spend)', () => {
  it('counts the lines of the orders placed in the period at their value now, a closed-short line at what came, another currency at the rate of the order, samples apart', async () => {
    const answer = await ok('buyer', '/purchasing/reports/spend')
    expect(answer).toMatchObject({ from: '2026-11-01', to: '2026-11-30', today: '2026-11-30', by: 'supplier', months: ['2026-11'], companyCurrency: 'EUR', sight: { orders: true, values: true }, more: 0, complete: true })
    // O1 420.00 + O3 60.00 (5 of 20 m²) + O5 100.00 (108.50 USD) + O9 10.00; O4 20.00 apart; O2 (October), the draft, the cancelled order and line, company A2's order: none.
    expect(answer.all).toMatchObject({ production: 59_000, samples: 2_000, currency: 'EUR', mixedCurrencies: false, orders: 4, lines: 4, sampleOrders: 1, sampleLines: 1 })
    expect((answer.groups as Json[]).map((entry) => entry.key)).toEqual([x.s1, x.s2])
    expect(group(answer, x.s1)).toMatchObject({ code: 'FORN-350-A', name: 'Conceria Inventata S.r.l.', production: 52_000, samples: 0, orders: 2, share: '88.1', months: [{ month: '2026-11', production: 52_000 }] })
    expect(group(answer, x.s2)).toMatchObject({ production: 7_000, samples: 2_000, orders: 2, sampleOrders: 1, share: '11.9' })
    const byCategory = await ok('buyer', '/purchasing/reports/spend?by=category')
    expect((byCategory.groups as Json[]).map((entry) => [entry.key, entry.production, entry.samples])).toEqual([
      ['LEATHER', 42_000, 0],
      ['PROTECTOR', 10_000, 0],
      ['TEXTILE', 6_000, 2_000],
      ['THREAD', 1_000, 0],
    ])
    const byMaterial = await ok('buyer', '/purchasing/reports/spend?by=material')
    expect(group(byMaterial, ids.leather)).toMatchObject({ code: 'TEST-LEATHER', production: 42_000 })
    const byCompany = await ok('buyer', '/purchasing/reports/spend?by=company')
    expect((byCompany.groups as Json[]).map((entry) => entry.key)).toEqual([ids.companyA])
  })

  it('reads another period, a site, and each month of a longer period', async () => {
    const october = await ok('buyer', '/purchasing/reports/spend?from=2026-10-01&to=2026-10-31')
    expect(october.all).toMatchObject({ production: 4_000, orders: 1 })
    const both = await ok('buyer', '/purchasing/reports/spend?from=2026-10-01&to=2026-11-30&by=month')
    expect(both.months).toEqual(['2026-10', '2026-11'])
    expect((both.groups as Json[]).map((entry) => [entry.key, entry.production])).toEqual([
      ['2026-10', 4_000],
      ['2026-11', 59_000],
    ])
    expect(group(both, '2026-10').months).toEqual([expect.objectContaining({ month: '2026-10', production: 4_000 }), expect.objectContaining({ month: '2026-11', production: 0 })])
    const a2 = await ok('buyer', `/purchasing/reports/spend?siteId=${ids.siteA2}`)
    expect(a2).toMatchObject({ site: { id: ids.siteA2 }, all: { production: 6_000, orders: 1 } })
  })

  it('gives the planner (no cost grain) counts only: no amount, no share, ranked by orders', async () => {
    const answer = await ok('planner', '/purchasing/reports/spend')
    expect(answer.sight).toEqual({ orders: true, values: false })
    const keys = keysOf(answer)
    for (const name of ['production', 'samples']) expect(keys).not.toContain(name)
    expect(answer.all).toMatchObject({ orders: 4, lines: 4, sampleOrders: 1 })
    // Two orders each: S2's sample order ranks it first (never an amount).
    expect((answer.groups as Json[]).map((entry) => [entry.key, entry.share])).toEqual([
      [x.s2, null],
      [x.s1, null],
    ])
    const lines = await ok('planner', `/purchasing/reports/spend/lines?by=supplier&key=${x.s1}`)
    expect(keysOf(lines)).not.toContain('spend')
    expect(lines.lines).toHaveLength(2)
  })

  it('without the orders’ own view: the page answers with nothing counted, said by sight', async () => {
    const answer = await ok('reportsOnly', '/purchasing/reports/spend')
    expect(answer).toMatchObject({ sight: { orders: false }, groups: [], all: { orders: 0, lines: 0 } })
  })

  it('refuses in words: no right, another company’s screen, a site of another company, an unknown key, a period after today', async () => {
    // Without the permission anywhere the route's manifest refuses first; held over another company only, the handler says why.
    await refused('noRight', '/purchasing/reports/spend', 403)
    expect((await refused('otherCompany', '/purchasing/reports/spend', 403)).message).toBe('Purchasing reports of this company are not in your role.')
    await refused('buyer', `/purchasing/reports/spend?siteId=${ids.siteC1}`, 404)
    await refused('buyer', '/purchasing/reports/spend?colour=black', 400)
    const late = await refused('buyer', '/purchasing/reports/spend?to=2026-12-01', 400)
    expect(late.issues.map((issue: Json) => issue.path)).toEqual(['querystring/to'])
  })
})

describe('the POs behind a bar (pop drill)', () => {
  it('lists the lines that make a group’s number, the newest placing first, with their spend; one kind on its own', async () => {
    const answer = await ok('buyer', `/purchasing/reports/spend/lines?by=supplier&key=${x.s1}`)
    expect(answer).toMatchObject({ key: x.s1, code: 'FORN-350-A', figures: { production: 52_000 }, more: 0 })
    expect((answer.lines as Json[]).map((line) => [line.number, line.seq, line.kind, line.placedOn, line.spend, line.currency])).toEqual([
      ['PO-350-5', 10, 'production', '2026-11-15', 10_000, 'EUR'],
      ['PO-350-1', 10, 'production', '2026-11-03', 42_000, 'EUR'],
    ])
    const samples = await ok('buyer', `/purchasing/reports/spend/lines?by=supplier&key=${x.s2}&kind=samples`)
    expect((samples.lines as Json[]).map((line) => [line.number, line.kind, line.spend])).toEqual([['PO-350-4', 'samples', 2_000]])
    const short = await ok('buyer', '/purchasing/reports/spend/lines?by=category&key=TEXTILE&kind=production')
    expect(short.lines).toEqual([expect.objectContaining({ number: 'PO-350-3', ended: 'CLOSED_SHORT', spend: 6_000, supplier: expect.objectContaining({ code: 'FORN-350-B' }), item: expect.objectContaining({ code: 'TEST-FABRIC' }) })])
  })

  it('refuses a key that cannot be one of the group’s, in words', async () => {
    for (const url of ['/purchasing/reports/spend/lines?by=category&key=NOPE', '/purchasing/reports/spend/lines?by=month&key=2026-09', '/purchasing/reports/spend/lines?by=supplier&key=FORN-350-A']) {
      expect((await refused('buyer', url, 400)).issues.map((issue: Json) => issue.path), url).toEqual(['querystring/key'])
    }
  })
})

describe('supply alerts (SCM-174)', () => {
  const alertsOf = (kind: string) => f.admin<Json>(`SELECT "recordId", "recordLabel", state, facts, "partyId", "companyId" FROM "Alert" WHERE "tenantId" = $1 AND "ruleKind" = $2 ORDER BY "raisedAt", id`, [ids.tenantA, kind])

  it('the engine’s pass makes the two built-in rules and raises a line confirmed later than needed and a supplier put on hold', async () => {
    const pass = await runAlertEvaluation({ database: f.database, log: QUIET, clock: { now: () => NOW } })
    expect(pass.failed).toBe(0)
    const rules = await f.admin<Json>(`SELECT "ruleKind", threshold, enabled FROM "AlertRule" WHERE "tenantId" = $1 AND "ruleKind" IN ('PO_CONFIRMED_LATE', 'SUPPLIER_STATUS_CHANGED') ORDER BY 1`, [ids.tenantA])
    expect(rules).toEqual([
      { ruleKind: 'PO_CONFIRMED_LATE', threshold: { days: 1 }, enabled: true },
      { ruleKind: 'SUPPLIER_STATUS_CHANGED', threshold: { days: 7 }, enabled: true },
    ])
    // O1's leather is needed on 20 December and confirmed for 3 January: 14 days. O5 is confirmed for its day: none.
    expect(await alertsOf('PO_CONFIRMED_LATE')).toEqual([
      expect.objectContaining({ recordId: x.o1, recordLabel: 'PO-350-1', state: 'OPEN', facts: expect.objectContaining({ days: 14, needDate: '2026-12-20', confirmedDate: '2027-01-03', seq: 10, lines: 1, salesOrder: '' }) }),
    ])
    // S2 on hold since 28 November (S3 blocked in October is past the rule's 7 days; S1 is approved).
    expect(await alertsOf('SUPPLIER_STATUS_CHANGED')).toEqual([
      expect.objectContaining({ recordId: x.s2, recordLabel: 'FORN-350-B Tessitura Inventata S.r.l.', partyId: x.s2, state: 'OPEN', facts: expect.objectContaining({ status: 'ON_HOLD', changedOn: '2026-11-28', openOrders: 3, unsentOrders: 0 }) }),
    ])
  })

  it('a supplier’s alert is seen only with its record’s view (parties.view)', async () => {
    const seen = await ok('alertsBuyer', '/alerts?ruleKind=SUPPLIER_STATUS_CHANGED')
    expect((seen.items as Json[]).map((item) => item.record.id)).toEqual([x.s2])
    const unseen = await ok('alertsNoParties', '/alerts?ruleKind=SUPPLIER_STATUS_CHANGED')
    expect(unseen.items).toEqual([])
    const po = await ok('alertsNoParties', '/alerts?ruleKind=PO_CONFIRMED_LATE')
    expect((po.items as Json[]).map((item) => item.record.id)).toEqual([x.o1])
  })

  it('clears when the condition goes: the supplier approved again, the line confirmed for its day', async () => {
    await force(`UPDATE "Party" SET "supplierStatus" = 'APPROVED', "supplierStatusReason" = NULL, "supplierStatusChangedAt" = $2 WHERE id = $1`, [x.s2, at('2026-11-30', 14)])
    await force(`UPDATE "PurchaseOrderLine" SET "confirmedDate" = '2026-12-20' WHERE id = $1`, [x.l1])
    const pass = await runAlertEvaluation({ database: f.database, log: QUIET, clock: { now: () => NOW } })
    expect(pass.failed).toBe(0)
    expect((await alertsOf('SUPPLIER_STATUS_CHANGED')).map((alert) => alert.state)).toEqual(['RESOLVED'])
    expect((await alertsOf('PO_CONFIRMED_LATE')).map((alert) => alert.state)).toEqual(['RESOLVED'])
  })
})
