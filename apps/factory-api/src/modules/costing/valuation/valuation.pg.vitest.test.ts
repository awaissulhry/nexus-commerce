import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAccounting, type AccountingSeed } from '../../../../../../packages/factory-db/seed/accounting'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { SYSTEM_ACTOR_ID, testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { endOfDay, valueStockAsOf } from './valuation'

/**
 * Stock valuation at any date, value by hide area and order margin from estimate to actual on the local stack
 * (B-W2a-29; FIN-039, SCM-256, FIN-047) with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security is real), the factory-db seeds up to accounting:
 *
 *   stock   lining lot SEED-LOT-LIN-01: 120 m of opening stock on 2026-10-01 at the 3.10 standard (372.00); leather lot
 *           SEED-LOT-LEA-01: hides H1 53.2 ft² and H2 51.8 ft² received on 2026-11-12 at PO1's 4.20 (223.44 + 217.56),
 *           H1 issued to SEED-WO-0001 on 2026-11-16 at the lot's 4.20 (−223.44)
 *   WIP     SEED-WO-0001: the hide 223.44 + the sewing labour 96.50 = 319.94 (B-W2a-21's two entries)
 *   orders  SEED-SO-0001 (12 jackets at 420.00 = 5,040.00, cost at quote 300.50 each = 3,606.00, the quote's snapshot
 *           231.50 material + 69.00 labour per piece; no work order); SEED-SO-0002 (7 jackets at 400.00 = 2,800.00, no
 *           cost at quote; SEED-WO-0001 makes all 7, its estimate at release 2,037.78 = material 1,618.48 + labour
 *           419.30); SEED-SO-0003 (4 pieces, no cost at quote, SEED-WO-0003 released without a complete estimate)
 *
 * The costing method stays UNDECIDED (the accountant's): every figure says it depends on it. Every figure is made up and
 * worked out by hand below. Run with `node scripts/factory/run-pg-tests.mjs modules/costing`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: AccountingSeed

const NS = 'costing-valuation'
const id = (key: string) => seedUuid(NS, key)
const tenant = id('tenant')
const companyA = id('company:A')
const companyB = id('company:B')
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `t-${run}-${++keys}`

const grain = (permissions: readonly string[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites: 'all', parties })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants })
const fromTemplate = (name: string): SessionContext => {
  const role = templateOf(name)!
  return office([grain([...role.permissions, ...role.grains.map((g) => `money.${g}`)])])
}
const SESSIONS: Record<string, SessionContext> = {
  finance: fromTemplate('finance'),
  sales: fromTemplate('sales'),
  warehouse: fromTemplate('warehouse'),
  planner: fromTemplate('planner'),
  production: office([grain(['workorders.view', 'inventory.issue', 'inventory.stock.view', 'costing.view', 'costing.ledger.manage'])]),
  companyB: office([grain(['inventory.stock.view', 'costing.view', 'money.cost', 'money.price', 'money.margin'], [companyB])]),
  otherParty: office([grain(['costing.view', 'money.cost', 'money.price', 'money.margin'], 'all', [newId()])]),
  otherTenant: { audience: 'office', tenantId: newId(), actorId: newId(), grants: [grain(['inventory.stock.view', 'costing.view', 'money.cost'])] },
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': key() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, url: string, status: number): Promise<Json> {
  const response = await call(session, 'GET', url)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : []
const VALUE = /^(value|unitCost|lotCost|valuePerM2|residue|balanceValue|unitPrice)$/
const COST = /cost/i
const AMOUNT = /^(quotedMargin|estimateMargin|actualMargin|marginChange|margin|marginLostSinceQuote)$/

beforeAll(async () => {
  db = await migratedDatabase('costing_valuation')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 16 } })
  await seedCore({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  await seedPrivacy({ db: database, namespace: NS })
  seeded = await seedAccounting({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const lotOf = async (code: string) => (await admin<{ id: string; siteId: string; itemId: string }>('SELECT id, "siteId", "itemId" FROM "Lot" WHERE code = $1', [code]))[0]!
const orderOf = async (number: string) => (await admin<{ id: string }>('SELECT id FROM "SalesOrder" WHERE number = $1', [number]))[0]!.id
const wo = () => seeded.money.shipping.quality.production.workOrderId
const ledgerValue = async () => Number((await admin<{ n: string }>('SELECT COALESCE(SUM("valueAmount"), 0)::text AS n FROM "StockValuation" WHERE "companyId" = $1', [companyA]))[0]!.n)
const wipValue = async () => Number((await admin<{ n: string }>('SELECT COALESCE(SUM(amount), 0)::text AS n FROM "WorkOrderCostEntry" WHERE "companyId" = $1', [companyA]))[0]!.n)
const rowsBy = (answer: Json) => Object.fromEntries(answer.rows.map((row: Json) => [row.lot?.code ?? row.workOrder?.number ?? row.item.code, row]))
const marginRow = async (number: string, session = 'finance') => (await ok(session, 'GET', '/costing/margins')).rows.find((row: Json) => row.order.number === number)

describe('stock valuation at any date (FIN-039)', () => {
  it('values the stock as the ledgers hold it: leather, lining and the work in progress, adding up to the ledgers', async () => {
    const answer = await ok('finance', 'GET', `/costing/valuation?companyId=${companyA}`)
    const by = rowsBy(answer)
    expect(Object.keys(by)).toEqual(['SEED-LOT-LEA-01', 'SEED-LOT-LIN-01', 'SEED-WO-0001'])
    // H2 51.8 ft² at 4.20 = 217.56 (H1 came in and went out at 4.20); 4.812377472 m².
    expect(by['SEED-LOT-LEA-01']).toMatchObject({ category: 'LEATHER', quantity: '51.8000', uom: 'FT2', hides: 1, areaM2: '4.8124', value: 21_756, unitCost: '4.200000', currency: 'EUR', methods: ['LOT_COST', 'PURCHASE_PRICE'], valued: 'FULL', dependsOnMethod: true })
    expect(by['SEED-LOT-LIN-01']).toMatchObject({ category: 'MATERIALS', quantity: '120.0000', uom: 'M', hides: 0, areaM2: null, value: 37_200, unitCost: '3.100000', methods: ['STANDARD_COST'] })
    expect(by['SEED-WO-0001']).toMatchObject({ category: 'WIP', item: null, quantity: null, value: 31_994, workOrder: { number: 'SEED-WO-0001', status: 'IN_PROGRESS', done: false } })
    expect(by['SEED-WO-0001'].words).toMatch(/Work in progress: what SEED-WO-0001 took on.*\(2 entries\)/)
    expect(answer.categories.filter((row: Json) => row.rows > 0)).toEqual([
      { category: 'LEATHER', rows: 1, value: 21_756, currency: 'EUR' },
      { category: 'MATERIALS', rows: 1, value: 37_200, currency: 'EUR' },
      { category: 'WIP', rows: 1, value: 31_994, currency: 'EUR' },
    ])
    expect(answer).toMatchObject({ asOf: null, value: 90_950, currency: 'EUR', residue: 0, unvaluedMoves: 0, truncated: false })
    expect(answer.methods).toEqual([expect.objectContaining({ companyId: companyA, method: 'UNDECIDED', provisional: true })])
    expect(answer.words).toMatch(/stock ledger's.*never recomputed.*not chosen yet/)
    // Provable: the stock rows (and the residue) are the StockValuation ledger, the WIP the cost ledger, to the cent.
    expect(21_756 + 37_200 + answer.residue).toBe(await ledgerValue())
    expect(31_994).toBe(await wipValue())
  })

  it('values the stock at the end of any day (Europe/Rome): before the receipt, after it, before the issue', async () => {
    expect((await ok('finance', 'GET', '/costing/valuation?asOf=2026-09-30')).rows).toEqual([])
    const opening = await ok('finance', 'GET', '/costing/valuation?asOf=2026-10-01')
    expect(opening).toMatchObject({ asOf: '2026-10-01T21:59:59.999Z', asOfDay: '2026-10-01', value: 37_200 })
    expect(opening.rows.map((row: Json) => row.lot.code)).toEqual(['SEED-LOT-LIN-01'])
    const received = await ok('finance', 'GET', '/costing/valuation?asOf=2026-11-13')
    // Both hides on hand: 105 ft² × 4.20 = 441.00; no work in progress yet (its entries are of 16 and 17 November).
    expect(rowsBy(received)['SEED-LOT-LEA-01']).toMatchObject({ quantity: '105.0000', hides: 2, value: 44_100, methods: ['PURCHASE_PRICE'] })
    expect(received.rows.some((row: Json) => row.category === 'WIP')).toBe(false)
    expect(received.value).toBe(81_300)
    // The year-end pack's function gives the same figures without a request (the system's view of every site).
    const system = callerFor(database, { audience: 'system', tenantId: tenant, actorId: SYSTEM_ACTOR_ID, grants: [], requestId: newId() })
    const pack = await system.withClient((client) => valueStockAsOf(client, { siteIds: null, companyId: companyA }, endOfDay('2026-11-13')))
    expect(pack.value).toBe(81_300)
    expect(pack.rows.map((row) => [row.lot?.code, row.value])).toEqual([['SEED-LOT-LEA-01', 44_100], ['SEED-LOT-LIN-01', 37_200]])
  })

  it('narrows by category, item and words; a company or a tenant out of scope sees nothing', async () => {
    expect((await ok('finance', 'GET', '/costing/valuation?category=LEATHER,WIP')).rows.map((row: Json) => row.category)).toEqual(['LEATHER', 'WIP'])
    expect((await ok('finance', 'GET', '/costing/valuation?q=lin')).rows.map((row: Json) => row.lot.code)).toEqual(['SEED-LOT-LIN-01'])
    expect((await ok('finance', 'GET', '/costing/valuation?q=wo-0001')).rows.map((row: Json) => row.workOrder.number)).toEqual(['SEED-WO-0001'])
    const leather = await lotOf('SEED-LOT-LEA-01')
    expect((await ok('finance', 'GET', `/costing/valuation?itemId=${leather.itemId}`)).rows.map((row: Json) => row.category)).toEqual(['LEATHER'])
    expect((await ok('companyB', 'GET', '/costing/valuation')).rows).toEqual([])
    expect((await ok('otherTenant', 'GET', '/costing/valuation')).rows).toEqual([])
  })

  it('shows the warehouse and the planner the quantities, never a value; sales (no stock view) is refused', async () => {
    for (const session of ['warehouse', 'planner']) {
      const answer = await ok(session, 'GET', '/costing/valuation')
      expect(answer.rows.map((row: Json) => row.quantity)).toEqual(['51.8000', '120.0000', null])
      expect(keysOf(answer).filter((name) => VALUE.test(name))).toEqual([])
    }
    await refused('sales', '/costing/valuation', 403)
  })
})

describe('how a lot is valued (the pop-up)', () => {
  it('lists the cost layers up to the date: each receipt at its order price, the issue at the lot cost', async () => {
    const lot = await lotOf('SEED-LOT-LEA-01')
    const url = `/costing/valuation/layers?siteId=${lot.siteId}&itemId=${lot.itemId}&lotId=${lot.id}`
    const answer = await ok('finance', 'GET', url)
    expect(answer.layers.map((layer: Json) => [layer.reason, layer.hide.code, layer.quantity, layer.method, layer.unitCost, layer.value, layer.balanceQuantity, layer.balanceValue])).toEqual([
      ['RECEIPT', expect.stringMatching(/^SEED-HIDE-000[12]$/), expect.any(String), 'PURCHASE_PRICE', '4.200000', expect.any(Number), expect.any(String), expect.any(Number)],
      ['RECEIPT', expect.stringMatching(/^SEED-HIDE-000[12]$/), expect.any(String), 'PURCHASE_PRICE', '4.200000', expect.any(Number), '105.0000', 44_100],
      ['ISSUE', 'SEED-HIDE-0001', '-53.2000', 'LOT_COST', '4.200000', -22_344, '51.8000', 21_756],
    ])
    expect(answer.layers[0]).toMatchObject({ receipt: { number: 'SEED-GR-0001' }, purchaseOrder: { number: 'SEED-PO-0001', unitPrice: '4.200000', uom: 'FT2', currency: 'EUR' } })
    expect(answer).toMatchObject({ quantity: '51.8000', value: 21_756, unitCost: '4.200000', lotCost: '4.200000', opening: { quantity: '0.0000', value: 0 }, complete: true, dependsOnMethod: true, lot: { code: 'SEED-LOT-LEA-01', qualityStatus: 'RELEASED' } })
    expect(answer.words).toMatch(/purchase order's price.*lot's average cost/)
    // The latest move only: the balance before it is the database's sum (105 ft², 441.00).
    const last = await ok('finance', 'GET', `${url}&limit=1`)
    expect(last).toMatchObject({ opening: { quantity: '105.0000', value: 44_100 }, complete: false, quantity: '51.8000', value: 21_756 })
    expect((await ok('finance', 'GET', `${url}&asOf=2026-11-13`)).layers.map((layer: Json) => layer.reason)).toEqual(['RECEIPT', 'RECEIPT'])
    const blind = await ok('warehouse', 'GET', url)
    expect(blind.layers).toHaveLength(3)
    expect(keysOf(blind).filter((name) => VALUE.test(name))).toEqual([])
    await refused('companyB', url, 403)
    await refused('finance', `/costing/valuation/layers?siteId=${lot.siteId}&itemId=${newId()}`, 404)
  })
})

describe('leather valued by area (SCM-256)', () => {
  it('gives the area on hand per article and colour with its value per m², lot by lot', async () => {
    const answer = await ok('finance', 'GET', '/costing/valuation/leather')
    // 51.8 ft² = 4.812377472 m²; 217.56 ÷ 4.812377472 = 45.208424 per m² (4.20 per ft²).
    expect(answer.rows).toEqual([
      expect.objectContaining({ item: expect.objectContaining({ code: 'SEED-LEA-100', baseUom: 'FT2' }), colour: expect.objectContaining({ code: 'BLK' }), hides: 1, quantity: '51.8000', areaM2: '4.8124', value: 21_756, valuePerM2: '45.208424', unitCost: '4.200000', valued: 'FULL', dependsOnMethod: true }),
    ])
    expect(answer.rows[0].lots).toEqual([expect.objectContaining({ lot: expect.objectContaining({ code: 'SEED-LOT-LEA-01' }), hides: 1, areaM2: '4.8124', value: 21_756, valuePerM2: '45.208424' })])
    expect(answer).toMatchObject({ hides: 1, areaM2: '4.8124', value: 21_756, valuePerM2: '45.208424', currency: 'EUR', notArea: 0 })
    expect(await ok('finance', 'GET', '/costing/valuation/leather?asOf=2026-11-13')).toMatchObject({ hides: 2, areaM2: '9.7548', value: 44_100, valuePerM2: '45.208424' })
    const blind = await ok('warehouse', 'GET', '/costing/valuation/leather')
    expect(blind).toMatchObject({ hides: 1, areaM2: '4.8124' })
    expect(keysOf(blind).filter((name) => VALUE.test(name))).toEqual([])
  })
})

describe('order margin from estimate to actual (FIN-047)', () => {
  it('lists each order quoted, estimated now and so far, with the tiles and the groups', async () => {
    const answer = await ok('finance', 'GET', '/costing/margins')
    expect(answer.rows.map((row: Json) => row.order.number)).toEqual(['SEED-SO-0003', 'SEED-SO-0001', 'SEED-SO-0002'])
    const [so3, so1, so2] = answer.rows
    // SO-0001: no work order: the estimate is the quoted cost; nothing spent yet, so no actual margin.
    expect(so1).toMatchObject({ quotedValue: 504_000, value: 504_000, quotedCost: 360_600, quotedMargin: 143_400, quotedMarginPct: '28.4524', estimateCost: 360_600, estimateMargin: 143_400, marginChange: 0, actualCost: 0, actualMargin: null, actualMarginPct: null, workOrders: 0, started: false, final: false, belowFloor: null, method: 'UNDECIDED', provisional: true })
    // SO-0002: no cost at quote; SEED-WO-0001 makes all 7 at its estimate at release 2,037.78; 319.94 spent so far.
    expect(so2).toMatchObject({ quotedCost: null, quotedMargin: null, estimateCost: 203_778, estimateMargin: 76_222, estimateMarginPct: '27.2221', actualCost: 31_994, actualMargin: 248_006, actualMarginPct: '88.5736', marginChange: null, workOrders: 1, started: true, final: false })
    expect(so3).toMatchObject({ quotedCost: null, estimateCost: null, workOrders: 1, started: false })
    // (5,040.00 − 3,606.00 + 2,800.00 − 2,037.78) ÷ 7,840.00.
    expect(answer.tiles).toEqual({ averageMarginPct: '28.013', belowFloor: null, marginLostSinceQuote: 0, orders: 3, unknown: 1, currency: 'EUR', words: null })
    expect(answer.byCustomer).toEqual([expect.objectContaining({ orders: 3, value: 952_000, estimateCost: null, marginPct: '28.013' })])
    expect(answer.byStyle.map((row: Json) => [row.style.code, row.value, row.estimateCost, row.marginPct])).toEqual([
      ['SEED-JKT-01', 504_000, 360_600, '28.4524'],
      ['SEED-JKT-02', 280_000, 203_778, '27.2221'],
      ['SEED-JKT-03', 168_000, null, null],
    ])
  })

  it('filters by words, status, period and style; a customer or a company out of scope sees nothing', async () => {
    expect((await ok('finance', 'GET', '/costing/margins?q=so-0001')).rows.map((row: Json) => row.order.number)).toEqual(['SEED-SO-0001'])
    expect((await ok('finance', 'GET', '/costing/margins?status=CANCELLED')).rows).toEqual([])
    expect((await ok('finance', 'GET', '/costing/margins?from=2026-11-01')).rows.map((row: Json) => row.order.number)).toEqual(['SEED-SO-0003', 'SEED-SO-0002'])
    const style = (await admin<{ id: string }>(`SELECT id FROM "Style" WHERE code = 'SEED-JKT-02'`))[0]!.id
    expect((await ok('finance', 'GET', `/costing/margins?styleId=${style}`)).rows.map((row: Json) => row.order.number)).toEqual(['SEED-SO-0002'])
    const page = await ok('finance', 'GET', '/costing/margins?limit=2')
    expect(page.rows).toHaveLength(2)
    expect((await ok('finance', 'GET', `/costing/margins?limit=2&cursor=${page.nextCursor}`)).rows.map((row: Json) => row.order.number)).toEqual(['SEED-SO-0002'])
    for (const session of ['otherParty', 'companyB']) {
      expect((await ok(session, 'GET', '/costing/margins')).rows).toEqual([])
      await refused(session, `/costing/margins/orders/${await orderOf('SEED-SO-0001')}`, 404)
    }
    await refused('warehouse', '/costing/margins', 403)
  })

  it("shows sales the margin %, never a cost or a margin amount (Owner answer S2)", async () => {
    const answer = await ok('sales', 'GET', '/costing/margins')
    const so1 = answer.rows.find((row: Json) => row.order.number === 'SEED-SO-0001')
    expect(so1).toMatchObject({ quotedValue: 504_000, quotedMarginPct: '28.4524', estimateMarginPct: '28.4524' })
    expect(keysOf(answer).filter((name) => COST.test(name) || AMOUNT.test(name))).toEqual([])
    expect(answer.tiles.averageMarginPct).toBe('28.013')
    const detail = await ok('sales', 'GET', `/costing/margins/orders/${await orderOf('SEED-SO-0002')}`)
    expect(detail.waterfall).toBeNull()
    expect(keysOf(detail).filter((name) => COST.test(name) || AMOUNT.test(name))).toEqual([])
    expect(detail.estimate.marginPct).toBe('27.2221')
  })

  it('explains one order: the parts at each stage, its lines and the work orders behind them', async () => {
    const so1 = await ok('finance', 'GET', `/costing/margins/orders/${await orderOf('SEED-SO-0001')}`)
    // The quote's mix per piece: 231.50 material, 69.00 labour → 2,778.00 + 828.00.
    expect(so1.quoted).toEqual({ value: 504_000, cost: 360_600, parts: { material: 277_800, labour: 82_800, subcontract: 0, overhead: 0, adjustment: 0 }, margin: 143_400, marginPct: '28.4524' })
    expect(so1.estimate.parts).toEqual(so1.quoted.parts)
    expect(so1.waterfall.every((step: Json) => step.amount === 0)).toBe(true)
    expect(so1.lines.map((line: Json) => [line.seq, line.quantity, line.inWorkOrders, line.quotedCost, line.estimateCost])).toEqual([[10, 8, 0, 240_400, 240_400], [20, 4, 0, 120_200, 120_200]])
    expect(so1.workOrderShares).toEqual([])
    expect(so1.words).toMatch(/not chosen yet.*No work order makes the order yet/)
    expect(so1.freight).toEqual({ cost: null, words: expect.stringMatching(/No freight cost/) })

    const so2 = await ok('finance', 'GET', `/costing/margins/orders/${await orderOf('SEED-SO-0002')}`)
    expect(so2.estimate.parts).toEqual({ material: 161_848, labour: 41_930, subcontract: 0, overhead: 0, adjustment: 0 })
    expect(so2.actual.parts).toEqual({ material: 22_344, labour: 9_650, subcontract: 0, overhead: 0, adjustment: 0 })
    // The work order's 7 garments: 4 BLK, 3 RED; its cost shared by garments, to the cent.
    expect(so2.lines.map((line: Json) => [line.seq, line.inWorkOrders, line.estimateCost, line.actualCost])).toEqual([[10, 4, 116_445, 18_282], [20, 3, 87_333, 13_712]])
    expect(so2.workOrderShares).toEqual([expect.objectContaining({ workOrder: expect.objectContaining({ number: 'SEED-WO-0001', status: 'IN_PROGRESS' }), pieces: 7, ofPieces: 7, done: false, plan: 'ESTIMATE', estimateCost: 203_778, actualCost: 31_994, method: 'UNDECIDED', provisional: true })])
    expect(so2.leather).toEqual({ quoted: null, actual: 22_344 })
    expect(so2.waterfall).toBeNull()
    expect(so2.words).toMatch(/The order is open.*larger of its plan/)
  })

  it('follows the order as it changes: a cost typed at quote, a line closed short, the frozen standards, material issued', async () => {
    // The office typed SO-0002's cost at quote: 280.00 a jacket (no cost sheet, so all of it material).
    await admin(`UPDATE "SalesOrderLine" SET "unitCost" = 280, "costAmount" = quantity * 28000 WHERE "orderId" = $1`, [await orderOf('SEED-SO-0002')])
    // One RED jacket of SO-0001 closed short: 4,620.00 left to deliver; 11 pieces at the quoted 300.50.
    await admin(`UPDATE "SalesOrderLine" SET "closedShortQuantity" = 1, "closedShortAt" = now(), "closedShortById" = $2, "closeShortReason" = 'The customer took three.' WHERE "orderId" = $1 AND seq = 20`, [await orderOf('SEED-SO-0001'), newId()])

    const so1 = await ok('finance', 'GET', `/costing/margins/orders/${await orderOf('SEED-SO-0001')}`)
    expect(so1).toMatchObject({ quotedValue: 504_000, value: 462_000, estimateCost: 330_550, estimateMargin: 131_450, estimateMarginPct: '28.4524', marginChange: -11_950 })
    expect(so1.waterfall).toEqual([
      { reason: 'PRICE', amount: -42_000 },
      { reason: 'MATERIAL', amount: 23_150 },
      { reason: 'LABOUR', amount: 6_900 },
      { reason: 'SUBCONTRACT', amount: 0 },
      { reason: 'OVERHEAD', amount: 0 },
      { reason: 'ADJUSTMENT', amount: 0 },
    ])
    expect(so1.quoted.margin + so1.waterfall.reduce((sum: number, step: Json) => sum + step.amount, 0)).toBe(so1.estimate.margin)
    expect(so1.words).toMatch(/1 piece\(s\) were closed short/)

    const so2 = await ok('finance', 'GET', `/costing/margins/orders/${await orderOf('SEED-SO-0002')}`)
    // Quoted 2,800.00 − 1,960.00 = 840.00 (30 %); now 762.22: the material came in 341.52 under, the labour 419.30 over it.
    expect(so2).toMatchObject({ quotedCost: 196_000, quotedMargin: 84_000, quotedMarginPct: '30', marginChange: -7_778 })
    expect(so2.waterfall).toEqual([
      { reason: 'PRICE', amount: 0 },
      { reason: 'MATERIAL', amount: 34_152 },
      { reason: 'LABOUR', amount: -41_930 },
      { reason: 'SUBCONTRACT', amount: 0 },
      { reason: 'OVERHEAD', amount: 0 },
      { reason: 'ADJUSTMENT', amount: 0 },
    ])
    expect((await ok('finance', 'GET', '/costing/margins')).tiles).toMatchObject({ averageMarginPct: '27.9881', marginLostSinceQuote: 19_728, unknown: 1 })

    // The six jackets' standards frozen from the cost sheet: the work order is now planned on them (2,037.78 again).
    const skus = await admin<{ id: string }>(`SELECT v.id FROM "Variant" v JOIN "Style" s ON s.id = v."styleId" WHERE s.code = 'SEED-JKT-02' ORDER BY v.sku`)
    const prepared = await ok('finance', 'POST', '/costing/standards/prepare', { companyId: companyA, validFrom: '2026-10-01', items: skus.map((sku) => ({ variantId: sku.id })) })
    for (const standard of prepared.prepared) await ok('finance', 'POST', `/costing/standards/${standard.id}/freeze`, { version: standard.version })
    const planned = await ok('finance', 'GET', `/costing/margins/orders/${await orderOf('SEED-SO-0002')}`)
    expect(planned.workOrderShares[0]).toMatchObject({ plan: 'STANDARD', estimateCost: 203_778 })

    // 2 m of lining issued to SEED-WO-0001 at the lot's 3.10: the stock leaves at 6.20, the work order takes it on.
    const before = await ok('finance', 'GET', `/costing/valuation?companyId=${companyA}`)
    const lining = await lotOf('SEED-LOT-LIN-01')
    await ok('production', 'POST', `/inventory/picking/work-orders/${wo()}/issue`, { lotId: lining.id, quantity: '2' }, 201)
    await ok('production', 'POST', `/costing/work-orders/${wo()}/post`, undefined, 201)
    const after = await ok('finance', 'GET', `/costing/valuation?companyId=${companyA}`)
    expect(rowsBy(after)['SEED-LOT-LIN-01']).toMatchObject({ quantity: '118.0000', value: 36_580 })
    expect(rowsBy(after)['SEED-WO-0001']).toMatchObject({ value: 32_614 })
    // Value moves from stock to WIP, none is made or lost: the total stays 909.50, and each ledger still agrees.
    expect(after.value).toBe(before.value)
    expect(21_756 + 36_580).toBe(await ledgerValue())
    expect(32_614).toBe(await wipValue())
    // The order's actual follows (the estimate does not: 229.64 of material is still under the plan's 1,618.48).
    expect(await marginRow('SEED-SO-0002')).toMatchObject({ actualCost: 32_614, actualMarginPct: '88.3521', estimateCost: 203_778 })
  })
})
