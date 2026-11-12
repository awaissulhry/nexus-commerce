import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../../core/app'
import { command } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { postMoves, type MoveDraft } from '../ledger/post-moves'
import { startInventoryFixture, type InventoryFixture } from '../ledger/testing/fixture'

/**
 * Warehouse reports (B-W2b-356; design warehouse.reports SCR-257) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security is real), on the inventory module's made-up world
 * (ledger/testing/fixture: company A with sites A1 and A2, company A2 with site C1, a second tenant). Every move is posted by
 * postMoves in an office command (valued as the ledger values it); the clock is 30 November 2026, so the default period is
 * November 2026 and the stock is aged at 30 November.
 *
 *   ageing   lining lot (no received day: its first move, 1 June 2025) 100 m · 310.00 → over a year; protectors (untracked)
 *            in 10 on 15 January and 5 on 20 October, 3 scrapped on 5 November → 5 of 0–90 days (20.00) and 7 of 181–365
 *            (28.00), first in, first out; fabric 20 m² on 1 July (152 days, 240.00); 4 protectors at A2 (all sites only);
 *            100 at company A2's site (never on company A's screen); a customer-owned lot: counted, never valued
 *   leather  supplier lot TEST-LOT-LEA-R (tannery lot TAN-77): hide R1 60 ft² received 10 October, R2 40 ft² received 3
 *            November (4.20 a ft²), 8 ft² of R1 scrapped, R2 split into a child lot (B-W2b-313: a value-neutral pair of
 *            adjustments, counted with its parent), 2 ft² of the child's hide found at a count; it adds up
 *
 * Reports per role: the page needs inventory.reports.view; figures need inventory.stock.view at the site; values the cost grain.
 * Refusals: no right, another company's screen, a site of another company, an unknown key, a period after today or too long.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/reports/`.
 */

type Json = Record<string, any>
const NOW = new Date('2026-11-30T15:00:00.000Z')
let f: InventoryFixture
let app: FastifyInstance
let ids: InventoryFixture['ids']
const extra = { supplier: newId(), order: newId(), orderLine: newId(), receipt: newId(), line: newId(), lot: newId(), hideR1: newId(), hideR2: newId(), child: newId(), childHide: newId(), ownedLot: newId(), customer: newId() }
let keys = 0
const key = () => `w2b356-${++keys}`

const grant = (permissions: readonly string[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions: permissions as Permission[], companies, sites, parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {}
const office = (permissions: string[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all', tenant: 'A' | 'B' = 'A') => (): SessionContext =>
  ({ audience: 'office', tenantId: tenant === 'A' ? ids.tenantA : ids.tenantB, actorId: newId(), companyId: tenant === 'A' ? ids.companyA : ids.companyB, grants: [grant(permissions, companies, sites)] }) as SessionContext
const READER = ['inventory.reports.view', 'inventory.stock.view']

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

async function post(drafts: MoveDraft[]): Promise<void> {
  await command(f.caller('manager'), { name: 'test.w2b356', idempotencyKey: key(), input: {} }, (tools) => postMoves(tools, drafts))
}
const day = (date: string, hour = 9) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00.000Z`)

beforeAll(async () => {
  f = await startInventoryFixture('inventory_reports')
  ids = f.ids
  Object.assign(SESSIONS, {
    reader: office([...READER, 'money.cost']),
    noCost: office(READER),
    reportsOnly: office(['inventory.reports.view']),
    noRight: office(['inventory.stock.view', 'money.cost']),
    otherCompany: office([...READER, 'money.cost'], [ids.companyA2]),
    siteA2: office([...READER, 'money.cost'], 'all', [ids.siteA2]),
    tenantB: office([...READER, 'money.cost'], 'all', 'all', 'B'),
  })
  const admin = f.admin
  // A supplier, a purchase order and its receipt of leather, the lot it made with its two hides, a child lot (a split), and a
  // customer-owned lining lot.
  await admin(`INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles) VALUES ($1, $2, $3, 'FORN-356', 'ORGANISATION', 'Conceria Inventata S.r.l.', '{SUPPLIER}'), ($4, $2, $3, 'CLI-356', 'ORGANISATION', 'Cliente Inventato S.r.l.', '{CUSTOMER}')`, [extra.supplier, ids.tenantA, ids.companyA, extra.customer])
  // A purchase order sent to the tannery (100 ft² at 4.20), received against it.
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate") VALUES ($1, $2, $3, $4, 'PO-356-1', $5, '2026-10-01')`, [extra.order, ids.tenantA, ids.companyA, ids.siteA1, extra.supplier])
  await admin(
    `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate")
     VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 100, 'FT2', 100, 4.2, 42000, '2026-10-10')`,
    [extra.orderLine, ids.tenantA, extra.order, extra.supplier, ids.siteA1, ids.leather, ids.leatherBlack],
  )
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "netAmount" = 42000, "sentAt" = $2 WHERE id = $1`, [extra.order, day('2026-10-01')])
  await admin(`INSERT INTO "GoodsReceipt" (id, "tenantId", "companyId", "siteId", number, "supplierId", "purchaseOrderId", kind, "receivedAt", status) VALUES ($1, $2, $3, $4, 'GR-356-1', $5, $6, 'STANDARD', $7, 'OPEN')`, [extra.receipt, ids.tenantA, ids.companyA, ids.siteA1, extra.supplier, extra.order, day('2026-10-10')])
  await admin(`INSERT INTO "GoodsReceiptLine" (id, "tenantId", "siteId", "receiptId", seq, "purchaseOrderLineId", "itemId", "itemColourId", quantity, uom, "baseQuantity") VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 100, 'FT2', 100)`, [extra.line, ids.tenantA, ids.siteA1, extra.receipt, extra.orderLine, ids.leather, ids.leatherBlack])
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "supplierId", "supplierLotRef", "dyeBatch", "receiptLineId", "receivedAt", "qualityStatus", "qualityDecidedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'TEST-LOT-LEA-R', $7, 'TAN-77', 'DB-1', $8, $9, 'RELEASED', $9)`,
    [extra.lot, ids.tenantA, ids.companyA, ids.siteA1, ids.leather, ids.leatherBlack, extra.supplier, extra.line, day('2026-10-10')],
  )
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "supplierId", "supplierLotRef", "receivedAt", "qualityStatus", "qualityDecidedAt", "parentLotId")
     VALUES ($1, $2, $3, $4, $5, $6, 'TEST-LOT-LEA-R-A', $7, 'TAN-77', $8, 'RELEASED', $8, $9)`,
    [extra.child, ids.tenantA, ids.companyA, ids.siteA1, ids.leather, ids.leatherBlack, extra.supplier, day('2026-10-10'), extra.lot],
  )
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "ownerPartyId", "qualityStatus", "qualityDecidedAt") VALUES ($1, $2, $3, $4, $5, $6, 'TEST-LOT-OWNED', $7, 'RELEASED', $8)`,
    [extra.ownedLot, ids.tenantA, ids.companyA, ids.siteA1, ids.lining, ids.liningGrey, extra.customer, day('2026-09-01')],
  )
  for (const [hideId, lotId, code, area] of [
    [extra.hideR1, extra.lot, 'TEST-HIDE-R1', '60'],
    [extra.hideR2, extra.lot, 'TEST-HIDE-R2', '40'],
    [extra.childHide, extra.child, 'TEST-HIDE-R2-A', '40'],
  ] as const) {
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, ids.tenantA, ids.siteA1, lotId, ids.leather, code, area])
  }

  const A1 = { siteId: ids.siteA1, toLocationId: ids.store }
  // Ageing.
  await post([{ ...A1, reason: 'ADJUSTMENT', itemId: ids.lining, lotId: ids.liningLot, quantity: '100', note: 'Counted at the start.', occurredAt: day('2025-06-01') }])
  await post([{ ...A1, reason: 'ADJUSTMENT', itemId: ids.protector, quantity: '10', note: 'Found.', occurredAt: day('2026-01-15') }])
  await post([{ ...A1, reason: 'ADJUSTMENT', itemId: ids.protector, quantity: '5', note: 'Found.', occurredAt: day('2026-10-20') }])
  await post([{ siteId: ids.siteA1, fromLocationId: ids.store, reason: 'SCRAP', itemId: ids.protector, quantity: '3', note: 'Broken.', occurredAt: day('2026-11-05') }])
  await post([{ ...A1, reason: 'ADJUSTMENT', itemId: ids.fabric, quantity: '20', note: 'Found.', occurredAt: day('2026-07-01') }])
  await post([{ siteId: ids.siteA2, toLocationId: ids.storeA2, reason: 'ADJUSTMENT', itemId: ids.protector, quantity: '4', note: 'Found.', occurredAt: day('2026-11-10') }])
  await post([{ siteId: ids.siteC1, toLocationId: ids.storeC1, reason: 'ADJUSTMENT', itemId: ids.protector, quantity: '100', note: 'Found.', occurredAt: day('2026-11-10') }])
  // A customer's own lining is never valued (the database refuses a valuation of it): its move goes in as it is, unvalued.
  await admin(
    `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "toLocationId", quantity, uom, "baseQuantity", note, "idempotencyKey", "occurredAt")
     VALUES ($1, $2, $3, $4, 'ADJUSTMENT', $5, $6, $7, $8, 30, 'M', 30, 'The customer sent it.', $9, $10)`,
    [newId(), ids.tenantA, ids.companyA, ids.siteA1, ids.lining, ids.liningGrey, extra.ownedLot, ids.store, key(), day('2026-09-01')],
  )
  // Leather: R1 received in October, R2 in November (4.20 a ft²); 8 ft² of R1 scrapped; R2 split into the child lot; 2 ft² found on the child's hide.
  const cost = { method: 'PURCHASE_PRICE' as const, unitCost: '4.2' }
  // A receipt's moves come with its posting (the database's rule at commit): both hides in one command, each on its own day.
  await command(f.caller('manager'), { name: 'test.w2b356.receipt', idempotencyKey: key(), input: {} }, async (tools) => {
    await postMoves(tools, [
      { ...A1, reason: 'RECEIPT', itemId: ids.leather, lotId: extra.lot, hideId: extra.hideR1, receiptLineId: extra.line, quantity: '60', occurredAt: day('2026-10-10'), cost },
      { ...A1, reason: 'RECEIPT', itemId: ids.leather, lotId: extra.lot, hideId: extra.hideR2, receiptLineId: extra.line, quantity: '40', occurredAt: day('2026-11-03'), cost },
    ])
    await tools.tx.goodsReceipt.update({ where: { id: extra.receipt }, data: { status: 'POSTED', postedAt: day('2026-11-03') } })
    return { posted: true }
  })
  await post([{ siteId: ids.siteA1, fromLocationId: ids.store, reason: 'SCRAP', itemId: ids.leather, lotId: extra.lot, hideId: extra.hideR1, quantity: '8', note: 'A hole.', reasonCode: 'WRITE_OFF', occurredAt: day('2026-11-06') }])
  await post([
    { siteId: ids.siteA1, fromLocationId: ids.store, reason: 'ADJUSTMENT', itemId: ids.leather, lotId: extra.lot, hideId: extra.hideR2, quantity: '40', note: 'Split into shade groups.', reasonCode: 'LOT_SPLIT', occurredAt: day('2026-11-07') },
    { ...A1, reason: 'ADJUSTMENT', itemId: ids.leather, lotId: extra.child, hideId: extra.childHide, quantity: '40', note: 'Split into shade groups.', reasonCode: 'LOT_SPLIT', occurredAt: day('2026-11-07'), cost: { method: 'MANUAL', unitCost: '4.2' } },
  ])
  await post([{ ...A1, reason: 'COUNT', itemId: ids.leather, lotId: extra.child, hideId: extra.childHide, quantity: '2', note: 'Counted more.', occurredAt: day('2026-11-08') }])

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

describe('stock ageing by material type', () => {
  it('ages every stock key at the period end: a lot by its received day (else its first move), untracked first in, first out', async () => {
    const answer = await ok('reader', `/inventory/reports/ageing?siteId=${ids.siteA1}`)
    expect(answer).toMatchObject({ from: '2026-11-01', to: '2026-11-30', asAt: '2026-11-30', today: '2026-11-30', site: { id: ids.siteA1, code: 'A1' }, sight: { stock: true, values: true } })
    expect(answer.sites.map((row: Json) => row.code)).toEqual(['A1'])
    const byType = Object.fromEntries(answer.types.map((row: Json) => [row.type, row]))
    expect(Object.keys(byType)).toEqual(['LEATHER', 'TEXTILE', 'LINING', 'PROTECTOR'])
    // Lining: the lot without a received day is as old as its first move (1 June 2025: 547 days); the customer's lot is counted, never valued.
    expect(byType.LINING.buckets.overYear).toEqual({ quantities: [{ uom: 'M', quantity: '100.0000' }], value: 31_000, share: '76.9' })
    expect(byType.LINING.buckets.d0to90).toEqual({ quantities: [{ uom: 'M', quantity: '30.0000' }], value: 0, share: '23.1' })
    expect(byType.LINING).toMatchObject({ whole: { quantities: [{ uom: 'M', quantity: '130.0000' }], value: 31_000 }, unvalued: 1, oldestDays: 547, keys: 2 })
    expect(answer.customerOwned).toBe(1)
    // Protectors: 10 in on 15 January, 5 on 20 October, 3 out on 5 November: the 5 newest are 41 days old, 7 of the January ones 319.
    expect(byType.PROTECTOR.buckets).toMatchObject({
      d0to90: { quantities: [{ uom: 'PCS', quantity: '5.0000' }], value: 2_000, share: '41.7' },
      d91to180: { quantities: [], value: 0, share: '0.0' },
      d181to365: { quantities: [{ uom: 'PCS', quantity: '7.0000' }], value: 2_800, share: '58.3' },
      overYear: { quantities: [], value: 0, share: '0.0' },
    })
    expect(byType.PROTECTOR).toMatchObject({ averageDays: '203.2', oldestDays: 319, currency: 'EUR' })
    expect(byType.TEXTILE.buckets.d91to180).toEqual({ quantities: [{ uom: 'M2', quantity: '20.0000' }], value: 24_000, share: '100.0' })
    // Leather in m²: R1 52 ft² left (60 − 8) and the child's hide 42 ft², both of the lot received on 10 October (51 days).
    expect(byType.LEATHER.buckets.d0to90.quantities).toEqual([{ uom: 'M2', quantity: '8.7329' }])
    expect(byType.LEATHER.articles).toHaveLength(1)
    expect(byType.LEATHER.articles[0]).toMatchObject({ item: { code: 'TEST-LEATHER' }, colour: { code: 'BLK' }, tracked: true, oldestDays: 51 })
    // The articles: the most over a year first.
    expect(byType.LINING.articles.map((row: Json) => row.colour?.code ?? null)).toEqual(['GRY'])
    expect(answer.all.value).toBe(31_000 + 2_000 + 2_800 + 24_000 + byType.LEATHER.whole.value)
  })

  it('every site of the screen\'s company, never another company\'s; a reader of one site reads that one', async () => {
    const all = await ok('reader', '/inventory/reports/ageing')
    expect(all.sites.map((row: Json) => row.code)).toEqual(['A1', 'A2'])
    const protectors = all.types.find((row: Json) => row.type === 'PROTECTOR')
    // 12 at A1 and 4 at A2; the 100 at company A2's site C1 are not on company A's screen.
    expect(protectors.whole.quantities).toEqual([{ uom: 'PCS', quantity: '16.0000' }])
    expect(protectors.articles).toHaveLength(1)
    const mine = await ok('siteA2', '/inventory/reports/ageing')
    expect(mine.sites.map((row: Json) => row.code)).toEqual(['A2'])
    expect(mine.types.map((row: Json) => [row.type, row.whole.quantities])).toEqual([['PROTECTOR', [{ uom: 'PCS', quantity: '4.0000' }]]])
    expect((await ok('tenantB', '/inventory/reports/ageing')).types).toEqual([])
  })

  it('the period\'s end is the day the stock is aged at: at 31 October nothing of November counts', async () => {
    const october = await ok('reader', `/inventory/reports/ageing?siteId=${ids.siteA1}&from=2026-10-01&to=2026-10-31`)
    const byType = Object.fromEntries(october.types.map((row: Json) => [row.type, row]))
    expect(byType.PROTECTOR.whole.quantities).toEqual([{ uom: 'PCS', quantity: '15.0000' }])
    expect(byType.PROTECTOR.buckets.d0to90.quantities).toEqual([{ uom: 'PCS', quantity: '5.0000' }])
    expect(byType.LEATHER.whole.quantities).toEqual([{ uom: 'M2', quantity: '5.5742' }])
  })
})

describe('leather use by article and supplier lot', () => {
  it('received, cut, back as remnant, scrapped, other, on hand at both ends: a split lot with its parent, and it adds up', async () => {
    const answer = await ok('reader', `/inventory/reports/leather?siteId=${ids.siteA1}`)
    expect(answer.articles).toHaveLength(1)
    const [article] = answer.articles
    expect(article).toMatchObject({ item: { code: 'TEST-LEATHER' }, colour: { code: 'BLK' } })
    expect(article.lots).toHaveLength(1)
    const [lot] = article.lots
    expect(lot).toMatchObject({ lot: { id: extra.lot, code: 'TEST-LOT-LEA-R' }, supplier: { code: 'FORN-356', name: 'Conceria Inventata S.r.l.' }, supplierLotRef: 'TAN-77', dyeBatch: 'DB-1', children: 1 })
    // Before November: R1 60 ft². November: R2 40 received, 8 scrapped, the split's pair cancels out, 2 found at a count. End: 52 + 42.
    expect(lot.figures).toMatchObject({
      uom: 'FT2',
      base: { start: '60.0000', received: '40.0000', issued: '0.0000', returned: '0.0000', remnant: '0.0000', cut: '0.0000', scrapped: '8.0000', other: '2.0000', end: '94.0000' },
      addsUp: true,
      hidesReceived: 1,
      hidesOnHand: 2,
      values: { start: 25_200, received: 16_800, cut: 0, scrapped: 3_360 },
      currency: 'EUR',
    })
    expect(lot.figures.m2).toMatchObject({ start: '5.5742', received: '3.7161', scrapped: '0.7432', end: '8.7329' })
    // The lot's value at the end: the ledger's (the count's 2 ft² at the lot's cost).
    expect(lot.figures.values.end).toBe(25_200 + 16_800 - 3_360 + 840)
    expect(article.figures.base).toEqual(lot.figures.base)
    expect(answer.all).toMatchObject({ uom: 'M2', addsUp: true, hidesReceived: 1, hidesOnHand: 2 })
    expect(answer.all.m2.received).toBe('3.7161')
    expect(answer).toMatchObject({ more: 0, unvaluedMoves: 0 })
  })

  it('a period with nothing of the lot shows its stock at both ends; nothing before it was received shows no lot', async () => {
    const december25 = await ok('reader', `/inventory/reports/leather?siteId=${ids.siteA1}&from=2025-12-01&to=2025-12-31`)
    expect(december25.articles).toEqual([])
    const october = await ok('reader', `/inventory/reports/leather?siteId=${ids.siteA1}&from=2026-10-01&to=2026-10-31`)
    expect(october.articles[0].lots[0].figures.base).toMatchObject({ start: '0.0000', received: '60.0000', end: '60.0000' })
  })
})

describe('reports per role', () => {
  it('without the cost grain no value leaves the API; the quantities are the same', async () => {
    const ageing = await ok('noCost', `/inventory/reports/ageing?siteId=${ids.siteA1}`)
    const leather = await ok('noCost', `/inventory/reports/leather?siteId=${ids.siteA1}`)
    expect(ageing.sight).toEqual({ stock: true, values: false })
    expect(keysOf(ageing).filter((name) => name === 'value')).toEqual([])
    expect(leather.articles[0].lots[0].figures.values).toEqual({})
    expect(leather.articles[0].figures.values).toEqual({})
    expect(leather.all.values).toEqual({})
    expect(leather.articles[0].lots[0].figures.base).toMatchObject({ received: '40.0000', end: '94.0000' })
    const withCost = await ok('reader', `/inventory/reports/ageing?siteId=${ids.siteA1}`)
    expect(ageing.types.map((row: Json) => row.whole.quantities)).toEqual(withCost.types.map((row: Json) => row.whole.quantities))
    expect(keysOf(ageing).some((name) => /person|worker|createdBy|postedBy/i.test(name))).toBe(false)
  })

  it('the page alone shows no figure: the stock needs inventory.stock.view, said by `sight`', async () => {
    const ageing = await ok('reportsOnly', '/inventory/reports/ageing')
    expect(ageing).toMatchObject({ sight: { stock: false, values: false }, sites: [], types: [], customerOwned: 0 })
    const leather = await ok('reportsOnly', '/inventory/reports/leather')
    expect(leather).toMatchObject({ sight: { stock: false }, articles: [], more: 0 })
  })
})

describe('refusals', () => {
  it('no inventory.reports.view; a reader of another company on company A\'s screen; a site of another company', async () => {
    await refused('noRight', '/inventory/reports/ageing', 403)
    expect((await refused('otherCompany', '/inventory/reports/leather', 403)).message).toBe('Warehouse reports of this company are not in your role.')
    expect((await refused('reader', `/inventory/reports/ageing?siteId=${ids.siteC1}`, 404)).message).toBe('Site not found.')
    expect((await refused('reader', `/inventory/reports/ageing?siteId=${newId()}`, 404)).message).toBe('Site not found.')
  })

  it('an unknown key, a period after today, too long, backwards', async () => {
    expect((await refused('reader', `/inventory/reports/ageing?workerId=${newId()}`, 400)).code).toBe('validation_failed')
    expect((await refused('reader', '/inventory/reports/ageing?from=2026-11-01&to=2026-12-01', 400)).message).toMatch(/cannot end after today/)
    expect((await refused('reader', '/inventory/reports/leather?from=2025-01-01&to=2026-11-30', 400)).message).toBe('A report covers at most 366 days.')
    expect((await refused('reader', '/inventory/reports/leather?from=2026-11-10&to=2026-11-01', 400)).message).toBe('The period ends before it starts.')
  })
})
