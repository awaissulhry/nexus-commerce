import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { lockOrderReceiving } from '../../purchasing/receiving'

/**
 * Goods receipts against a purchase order (B-W1-32; SCM-113, SCM-116, SCM-117, SCM-121, SCM-187, SCM-232, SCM-233,
 * SCM-247; PLAN §4.7 stages 09a-receive and 09b-cr6) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants and the
 * …_supply_guards triggers are real), the factory-db seeds of two tenants up to production (the black cowhide by the
 * hide in ft² that needs the chromium VI test, grey lining by the lot in metres, certified shoulder protectors by the
 * lot; site A1 with its goods-in dock A1-RCV; SEED-WO-0001 in progress) and the numbering seed (each company's
 * GOODS_RECEIPT series and its own LOT prefix). Purchase orders to the seeded supplier P2 are made up here, SENT or
 * CONFIRMED, without a contact (a cancel mails nobody). Sessions come from the test authenticator. Every name, number
 * and price is made up. Run with `node scripts/factory/run-pg-tests.mjs receipts`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'receipts-a', b: 'receipts-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  supplier: idOf(ns.a, 'party:P2'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  dock: idOf(ns.a, 'inventory:location:A1-RCV'),
  store: idOf(ns.a, 'inventory:location:A1-STORE'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  workOrder: idOf(ns.a, 'production:work-order:WO-0001'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const RECEIVE: Permission[] = ['inventory.receive', 'inventory.stock.view', 'inventory.reverse']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  /** Receives and reverses, with the cost grain. */
  manager: office(A.tenant, [grant([...RECEIVE, 'money.cost'])]),
  /** The warehouse role: receives, reverses, issues, moves stock; no cost grain. */
  warehouse: office(A.tenant, [grant([...RECEIVE, 'inventory.issue', 'inventory.issue.over', 'inventory.transfer'])]),
  viewer: office(A.tenant, [grant(['inventory.stock.view'])]),
  planner: office(A.tenant, [grant(['planning.view'])]),
  buyer: office(A.tenant, [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send'])]),
  companyB: office(A.tenant, [grant([...RECEIVE, 'money.cost'], [A.companyB])]),
  otherTenant: office(B.tenant, [grant([...RECEIVE, 'money.cost'])]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [grant(['floor.work', 'inventory.receive', 'inventory.locations.view'], [A.companyA], [A.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const freshKey = () => `rc-${run}-${++counter}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload, freshKey())
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))

/** On hand of a hide or lot at a location, from the ledger. */
async function onHand(locationId: string, where: { hideId?: string; lotId?: string }): Promise<string> {
  const [row] = await admin<{ n: string }>(
    `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::numeric(18,4)::text AS n
       FROM "StockMove" WHERE ("toLocationId" = $1 OR "fromLocationId" = $1) AND ($2::uuid IS NULL OR "hideId" = $2) AND ($3::uuid IS NULL OR "lotId" = $3)`,
    [locationId, where.hideId ?? null, where.lotId ?? null],
  )
  return row!.n
}
const orderOf = async (id: string) => (await admin<{ status: string; version: number }>('SELECT status::text AS status, version FROM "PurchaseOrder" WHERE id = $1', [id]))[0]!
const receiptsOf = async (orderId: string) => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "GoodsReceipt" WHERE "purchaseOrderId" = $1', [orderId]))[0]!.n
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

// ---- made-up purchase orders ---------------------------------------------------------------------------------------------------

interface LineSpec {
  readonly itemId: string
  readonly colourId: string | null
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly tolerancePct?: string
  readonly estimatedHides?: number
  readonly requiresCrViTest?: boolean
  readonly oneDyeBatch?: boolean
  readonly thickness?: readonly [string, string]
}
let orders = 0
/** A purchase order of company A for site A1 to the supplier P2, SENT (or CONFIRMED), without a contact. */
async function makeOrder(status: 'SENT' | 'CONFIRMED', lines: readonly LineSpec[]): Promise<{ id: string; number: string; lines: string[] }> {
  const id = newId()
  const number = `T-PO-${run}-${++orders}`
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, $5, $6, current_date, $7)`, [id, A.tenant, A.companyA, A.siteA1, number, A.supplier, A.actor])
  const lineIds: string[] = []
  let total = 0
  for (const [index, line] of lines.entries()) {
    const lineId = newId()
    lineIds.push(lineId)
    const amount = Math.round(Number(line.quantity) * Number(line.unitPrice) * 100)
    total += amount
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate",
         "areaTolerancePct", "estimatedHides", "requiresCrViTest", "oneDyeBatch", "thicknessMinMm", "thicknessMaxMm")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $9, $11, $12, current_date + 20, $13, $14, $15, $16, $17, $18)`,
      [lineId, A.tenant, id, A.supplier, A.siteA1, (index + 1) * 10, line.itemId, line.colourId, line.quantity, line.uom, line.unitPrice, amount, line.tolerancePct ?? null, line.estimatedHides ?? null, line.requiresCrViTest ?? false, line.oneDyeBatch ?? false, line.thickness?.[0] ?? null, line.thickness?.[1] ?? null],
    )
  }
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = $3, version = 2 WHERE id = $1`, [id, A.actor, total])
  if (status === 'CONFIRMED') await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', version = 3 WHERE id = $1`, [id])
  return { id, number, lines: lineIds }
}
const leatherLine = (quantity: string, extra: Partial<LineSpec> = {}): LineSpec => ({ itemId: A.leather, colourId: A.leatherBLK, quantity, uom: 'FT2', unitPrice: '5.000000', tolerancePct: '5', requiresCrViTest: true, oneDyeBatch: true, ...extra })
const hidesOf = (prefix: string, areas: readonly string[], extra: (index: number) => Json = () => ({})) => areas.map((area, index) => ({ supplierCode: `${prefix}-${String(index + 1).padStart(2, '0')}`, area, grade: 'A', thicknessMm: '1.2', ...extra(index) }))
const receive = (body: Json, session = 'manager', key: string | undefined = freshKey()) => call(session, 'POST', '/inventory/receipts', body, key)

beforeAll(async () => {
  db = await migratedDatabase('receipts')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

// ---- leather: hides one by one, quarantine, the order's progress -----------------------------------------------------------------

describe('leather received hide by hide against a confirmed order', () => {
  // 1000 ft² of black cowhide at 5.00 a ft², ± 5%, about 19 hides, one dye batch, 1.10–1.30 mm, Cr VI tested.
  let order: Awaited<ReturnType<typeof makeOrder>>
  let first: Json
  // Eleven hides measured in ft² (560.5 ft²) and one in m²: 4.8 m² = 4.8 / 0.09290304 = 51.66677… → 51.6668 ft².
  const AREAS = ['52.3', '48.9', '55.1', '50.0', '47.6', '53.4', '51.2', '49.8', '54.7', '50.6', '46.9']

  beforeAll(async () => {
    order = await makeOrder('CONFIRMED', [leatherLine('1000', { estimatedHides: 19, thickness: ['1.10', '1.30'] })])
  })

  it('records 12 hides with their measured areas: lot in quarantine (Cr VI pending), stock in the ledger, order PARTLY_RECEIVED', async () => {
    const before = await orderOf(order.id)
    const hides = [...hidesOf('T1', AREAS, (index) => (index === 2 ? { thicknessMm: '1.35' } : {})), { supplierCode: 'T1-12', area: '4.8', areaUom: 'M2', grade: 'B', thicknessMm: '1.25', defects: 'Scar near the neck.' }]
    const answer = await ok('manager', 'POST', '/inventory/receipts', {
      purchaseOrderId: order.id,
      supplierDdtNumber: 'DDT-T-0042',
      supplierDdtDate: '2026-10-28',
      lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ supplierLotRef: 'TAN-LOT-881', dyeBatch: 'DB-T1', shade: 'Black 01', hides }] }],
    }, 201)
    first = answer.receipt
    expect(first).toMatchObject({ status: 'POSTED', purchaseOrder: { id: order.id, status: 'PARTLY_RECEIVED', version: before.version + 1 }, supplierDdtNumber: 'DDT-T-0042', location: { id: A.dock, code: 'A1-RCV' } })
    expect(first.number).toMatch(/^GR-\d{4}-\d{4}$/)
    expect(first.summary).toEqual({ lines: 1, lots: 1, lotsInQuarantine: 1, lotsReleased: 0, hides: 12, quantities: [{ uom: 'FT2', baseQuantity: '612.1668' }] })
    const [line] = first.lines
    // Mixed units: the line is in the base unit; 612.1668 of 1000 ft², 387.8332 still open.
    expect(line).toMatchObject({ seq: 10, quantity: '612.1668', uom: 'FT2', baseQuantity: '612.1668', hideCount: 12 })
    expect(line.orderLine).toMatchObject({ expected: '1000.0000', received: '612.1668', open: '387.8332', tolerancePct: '5', estimatedHides: 19 })
    expect(line.difference).toMatchObject({ kind: 'SHORT', open: '387.8332' })
    const [lot] = line.lots
    expect(lot.code).toMatch(/^LA-\d{6}$/)
    expect(lot).toMatchObject({ qualityStatus: 'QUARANTINE', requiresCrViTest: true, crViStatus: 'PENDING', crViLimitMgKg: '3.000', holds: ['CR_VI_TEST'], dyeBatch: 'DB-T1', baseQuantity: '612.1668', hideCount: 12 })
    expect(lot.words).toMatch(/^In quarantine: waits for its chromium VI result/)
    expect(answer.notes.map((note: Json) => note.code)).toEqual(['SHORT', 'HIDE_COUNT', 'THICKNESS', 'QUARANTINE'])
    expect(answer.notes[0].message).toBe('Line 10 (SEED-LEA-100 BLK): 612.1668 ft² received of 1000 ft² expected; 387.8332 ft² still open (the order waits for it).')
    expect(answer.notes[1].message).toBe('Line 10 (SEED-LEA-100 BLK): 12 hides came; about 19 were expected.')
    expect(answer.notes[2].message).toBe('Line 10 (SEED-LEA-100 BLK): 1 hide outside the 1.10–1.30 mm asked (T1-03).')
    expect(answer.moves).toHaveLength(12)
    expect(answer.moves.every((move: Json) => move.reason === 'RECEIPT' && move.toLocationId === A.dock && move.valued)).toBe(true)

    // Each hide: its own tag (the tenant's HIDE scan id), area as measured and in the base unit.
    const lots = await ok('viewer', 'GET', `/inventory/receipts/${first.id}/lots`)
    const tag = tenantTag(A.tenant)
    const hideRows = lots.lots[0].hides as Json[]
    expect(hideRows).toHaveLength(12)
    expect(hideRows.every((hide) => parseScanId(hide.code, { types: ['HIDE'], tenantTag: tag }).ok)).toBe(true)
    expect(new Set(hideRows.map((hide) => hide.code)).size).toBe(12)
    expect(hideRows.find((hide) => hide.supplierCode === 'T1-12')).toMatchObject({ area: '4.8000', areaUom: 'M2', baseArea: '51.6668', grade: 'B', thicknessMm: '1.25', shade: 'Black 01', state: 'FULL', onHand: '51.6668', locationId: A.dock })
    expect(lots.lots[0]).toMatchObject({ onHand: '612.1668', hideCount: 12 })
    expect(await onHand(A.dock, { lotId: lot.id })).toBe('612.1668')

    // The cost grain: the manager sees the value at the order's price (11 hides 560.5 × 5 = 2802.50; 51.6668 × 5 = 258.33),
    // the warehouse (no cost grain) never receives a value key.
    expect(first.value).toEqual({ currency: 'EUR', valueAmount: 306_083 })
    expect(await admin(`SELECT method::text AS method, "unitCost"::text AS "unitCost", count(*)::int AS n FROM "StockValuation" WHERE "lotId" = $1 GROUP BY 1, 2`, [lot.id])).toEqual([{ method: 'PURCHASE_PRICE', unitCost: '5.000000', n: 12 }])
    const asWarehouse = await ok('warehouse', 'GET', `/inventory/receipts/${first.id}`)
    expect(keysOf(asWarehouse).filter((key) => /value|cost|price|amount/i.test(key))).toEqual([])
    expect(keysOf(lots).filter((key) => /value|cost|price|amount/i.test(key))).toEqual([])

    // Audit and events: the receipt, the lot, every hide and move; the order's move; one receipt_posted.
    expect(await admin(`SELECT action, before, after->>'status' AS status FROM "AuditLog" WHERE "recordType" = 'PurchaseOrder' AND "recordId" = $1`, [order.id])).toEqual([{ action: 'purchasing.received', before: { status: 'CONFIRMED' }, status: 'PARTLY_RECEIVED' }])
    expect(await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE action = 'inventory.hideReceived' AND after->>'lotId' = $1`, [lot.id])).toEqual([{ n: 12 }])
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE subject = $1`, [first.id])).toEqual([{ type: 'inventory.receipt_posted' }])
  })

  it('the stock exists but is not usable: the overview holds it, planning says "Cr VI pending"', async () => {
    const lot = first.lines[0].lots[0]
    const stock = await ok('viewer', 'GET', `/inventory/stock?lotId=${lot.id}`)
    expect(stock.items).toEqual([expect.objectContaining({ onHand: '612.1668', held: '612.1668', available: '0.0000', hides: 12, heldHides: 12 })])
    const unusable = await ok('planner', 'GET', `/planning/unusable-stock?siteId=${A.siteA1}`)
    const mine = (unusable.lines as Json[]).find((entry) => entry.lot.id === lot.id)
    expect(mine).toMatchObject({ quantity: '612.1668', hides: 12, reason: 'CR_VI_PENDING', words: 'no chromium VI test result yet', held: true })
    // Only RELEASED stock is issued (REACH Annex XVII entry 47): the pick refuses a hide of this lot.
    const hide = (await ok('viewer', 'GET', `/inventory/receipts/${first.id}/lots`)).lots[0].hides[0]
    const issue = await call('warehouse', 'POST', `/inventory/picking/work-orders/${A.workOrder}/issue`, { hideId: hide.id, overIssueReason: 'Test: never issued' }, freshKey())
    expect(issue.statusCode, issue.body).toBe(409)
    expect(issue.json().error.issues[0].path).toBe('refusal/CR_VI_PENDING')
  })

  it('the rest arrives in another dye batch: within the tolerance, the order is RECEIVED; nothing more is received against it', async () => {
    const answer = await ok('manager', 'POST', '/inventory/receipts', {
      purchaseOrderId: order.id,
      supplierDdtNumber: 'DDT-T-0051',
      supplierDdtDate: '2026-10-29',
      lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ dyeBatch: 'DB-T2', hides: hidesOf('T2', ['50', '50', '50', '50', '50', '50', '50']) }] }],
    }, 201)
    // 612.1668 + 350 = 962.1668 ft², at least 950 (1000 − 5%): the line is received.
    expect(answer.receipt.purchaseOrder.status).toBe('RECEIVED')
    expect(answer.receipt.lines[0].difference).toMatchObject({ kind: 'WITHIN_TOLERANCE', after: '962.1668', open: '0.0000' })
    expect(answer.notes.map((note: Json) => note.code)).toEqual(['WITHIN_TOLERANCE', 'ONE_DYE_BATCH', 'QUARANTINE'])
    expect(answer.notes[1].message).toBe('Line 10 (SEED-LEA-100 BLK): the order asked one dye batch; 2 came (DB-T1, DB-T2). Keep the shades apart when cutting.')
    expect(answer.receipt.lines[0].lots[0].code > first.lines[0].lots[0].code).toBe(true)
    expect((await orderOf(order.id)).status).toBe('RECEIVED')
    expect((await ok('manager', 'GET', `/inventory/receipts/expected?purchaseOrderId=${order.id}`)).lines).toEqual([])
    const more = await refused('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ hides: hidesOf('T3', ['40']) }] }] }, 409)
    expect(more.message).toMatch(/received in full: record extra goods against a new order/)
    // The list: newest first, two receipts of this order.
    const list = await ok('manager', 'GET', `/inventory/receipts?purchaseOrderId=${order.id}`)
    expect(list.receipts.map((receipt: Json) => [receipt.id, receipt.hides, receipt.lots, receipt.quantities])).toEqual([
      [answer.receipt.id, 7, 1, [{ uom: 'FT2', baseQuantity: '350.0000' }]],
      [first.id, 12, 1, [{ uom: 'FT2', baseQuantity: '612.1668' }]],
    ])
    expect(list.receipts[1].value).toEqual({ currency: 'EUR', valueAmount: 306_083 })
  })
})

// ---- lots, holds and the tolerance ------------------------------------------------------------------------------------------------

describe('lots and the order line\'s tolerance', () => {
  it('more than the order line allows needs the reason; lots start RELEASED, or held (a PPE certificate, the receiver\'s hold)', async () => {
    // 100 m of grey lining (no tolerance) at 3.00 a m and 24 certified protectors at 6.50.
    const order = await makeOrder('SENT', [
      { itemId: A.lining, colourId: A.liningGRY, quantity: '100', uom: 'M', unitPrice: '3.000000' },
      { itemId: A.protector, colourId: null, quantity: '24', uom: 'PCS', unitPrice: '6.500000' },
    ])
    const body = (reason?: string) => ({
      purchaseOrderId: order.id,
      lines: [
        { purchaseOrderLineId: order.lines[0], lots: [{ supplierLotRef: 'ROLL-1', quantity: '60' }, { supplierLotRef: 'ROLL-2', quantity: '50', holdReason: 'Wet cartons' }], ...(reason ? { differenceReason: reason } : {}) },
        { purchaseOrderLineId: order.lines[1], lots: [{ supplierLotRef: 'PRO-77', quantity: '24' }] },
      ],
    })
    const over = await refused('manager', 'POST', '/inventory/receipts', body(), 409)
    expect(over.issues).toEqual([
      {
        path: 'body/lines/0/differenceReason',
        message: 'Line 10 (SEED-LIN-200 GRY): 110 m received of 100 m expected (no tolerance: at most 100 m); 10 m more than expected. Give the reason the extra is taken, or receive only what was ordered.',
      },
    ])
    expect(await receiptsOf(order.id)).toBe(0)

    const answer = await ok('manager', 'POST', '/inventory/receipts', body('The supplier sent full rolls; we keep them'), 201)
    const [lining, protector] = answer.receipt.lines
    expect(lining).toMatchObject({ quantity: '110.0000', uom: 'M', note: 'Difference from the order: The supplier sent full rolls; we keep them', difference: { kind: 'OVER', difference: '10.0000' } })
    expect(lining.lots.map((lot: Json) => [lot.qualityStatus, lot.holds, lot.baseQuantity])).toEqual([
      ['RELEASED', [], '60.0000'],
      ['QUARANTINE', ['QUALITY_HOLD'], '50.0000'],
    ])
    expect(lining.lots[1].words).toBe('In quarantine: held at receipt: Wet cartons. Not usable until released.')
    expect(protector.lots[0]).toMatchObject({ qualityStatus: 'QUARANTINE', holds: ['PPE_CERTIFICATE'], crViStatus: 'NOT_REQUIRED', crViLimitMgKg: null })
    expect(answer.receipt.purchaseOrder.status).toBe('RECEIVED')
    expect(answer.notes.map((note: Json) => note.code)).toEqual(['NO_SUPPLIER_DDT', 'OVER', 'QUARANTINE', 'QUARANTINE'])
    // Valued at the order's prices: 110 m × 3.00 = 330.00, 24 × 6.50 = 156.00.
    expect(answer.receipt.lines.map((line: Json) => line.value)).toEqual([
      { currency: 'EUR', valueAmount: 33_000 },
      { currency: 'EUR', valueAmount: 15_600 },
    ])
    expect(await admin(`SELECT reason FROM "AuditLog" WHERE action = 'inventory.receive' AND "recordId" = $1`, [answer.receipt.id])).toEqual([{ reason: 'The supplier sent full rolls; we keep them' }])
  })

  it('refuses what a line cannot be, all at once, writing nothing', async () => {
    const order = await makeOrder('SENT', [leatherLine('200'), { itemId: A.lining, colourId: A.liningGRY, quantity: '50', uom: 'M', unitPrice: '3.000000' }])
    const error = await refused('manager', 'POST', '/inventory/receipts', {
      purchaseOrderId: order.id,
      lines: [
        { purchaseOrderLineId: order.lines[0], quantity: '100', lots: [{ hides: [{ area: '50', areaUom: 'M' }] }] },
        { purchaseOrderLineId: order.lines[1], lots: [{ hides: [{ area: '1' }] }] },
        { purchaseOrderLineId: newId(), quantity: '1' },
      ],
    }, 400)
    expect(error.issues.map((issue: Json) => issue.path)).toEqual([
      'body/lines/0/quantity',
      'body/lines/0/lots/0/hides/0/areaUom',
      'body/lines/1/lots/0/hides',
      'body/lines/1/lots/0/quantity',
      'body/lines/2/purchaseOrderLineId',
    ])
    const future = await refused('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, receivedAt: new Date(Date.now() + 3_600_000).toISOString(), lines: [{ purchaseOrderLineId: order.lines[1], lots: [{ quantity: '5' }] }] }, 400)
    expect(future.issues).toEqual([{ path: 'body/receivedAt', message: 'Now or earlier.' }])
    expect(await receiptsOf(order.id)).toBe(0)
    expect((await orderOf(order.id)).status).toBe('SENT')
  })

  it('a repeated Idempotency-Key answers the first receipt again and posts nothing more', async () => {
    const order = await makeOrder('SENT', [{ itemId: A.lining, colourId: A.liningGRY, quantity: '50', uom: 'M', unitPrice: '3.000000' }])
    const body = { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '20' }] }] }
    const key = freshKey()
    const once = await ok('manager', 'POST', '/inventory/receipts', body, 201, key)
    const again = await ok('manager', 'POST', '/inventory/receipts', body, 201, key)
    expect(again.receipt.id).toBe(once.receipt.id)
    expect(await receiptsOf(order.id)).toBe(1)
    expect((await call('manager', 'POST', '/inventory/receipts', { ...body, note: 'another body' }, key)).statusCode).toBe(409)
  })
})

// ---- reversing a receipt ----------------------------------------------------------------------------------------------------------------

describe('reversing a receipt', () => {
  const twoHides = async () => {
    const order = await makeOrder('CONFIRMED', [leatherLine('200')])
    const answer = await ok('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: 'DDT-T-R', lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ dyeBatch: 'DB-R', hides: hidesOf('R', ['100', '98']) }] }] }, 201)
    return { order, receipt: answer.receipt as Json, hides: (await ok('viewer', 'GET', `/inventory/receipts/${answer.receipt.id}/lots`)).lots[0].hides as Json[] }
  }

  it('posts one mirror move per receipt move: the stock is gone, the lot rejected, the values cancel, the order back to CONFIRMED', async () => {
    const { order, receipt, hides } = await twoHides()
    // 198 of 200 ft² ± 5%: received.
    expect(receipt.purchaseOrder.status).toBe('RECEIVED')
    expect(receipt.reversal).toEqual({ possible: true, location: 'A1-RCV', blockers: [] })
    expect(await refused('warehouse', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: receipt.version, reason: 'no' }, 400)).toMatchObject({ code: 'validation_failed' })
    expect(await refused('viewer', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: receipt.version, reason: 'Booked against the wrong order' }, 403)).toBeTruthy()

    const answer = await ok('warehouse', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: receipt.version, reason: 'Booked against the wrong order' }, 201, freshKey())
    expect(answer.receipt).toMatchObject({ status: 'REVERSED', reversalReason: 'Booked against the wrong order', reversal: null, purchaseOrder: { status: 'CONFIRMED' } })
    expect(answer.moves).toHaveLength(2)
    expect(answer.moves.map((move: Json) => [move.reason, move.fromLocationId, move.toLocationId, move.note])).toEqual([
      ['RECEIPT', A.dock, null, `Receipt ${receipt.number} reversed: Booked against the wrong order`],
      ['RECEIPT', A.dock, null, `Receipt ${receipt.number} reversed: Booked against the wrong order`],
    ])
    for (const hide of hides) expect(await onHand(A.dock, { hideId: hide.id })).toBe('0.0000')
    const lot = answer.receipt.lines[0].lots[0]
    expect(lot).toMatchObject({ qualityStatus: 'REJECTED', qualityNote: `Receipt ${receipt.number} reversed: Booked against the wrong order`, words: 'Rejected: never used.' })
    // 198 × 5.00 in, then out again at the same cost.
    expect(await admin(`SELECT sum("valueAmount")::int AS total, count(*)::int AS n FROM "StockValuation" WHERE "lotId" = $1`, [lot.id])).toEqual([{ total: 0, n: 4 }])
    expect(await orderOf(order.id)).toMatchObject({ status: 'CONFIRMED' })
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id`, [receipt.id])).toEqual([{ type: 'inventory.receipt_posted' }, { type: 'inventory.receipt_reversed' }])

    // Once only: the old version is stale, the new one finds it reversed.
    expect((await refused('manager', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: receipt.version, reason: 'Again' }, 409)).code).toBe('conflict')
    expect((await refused('manager', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: answer.receipt.version, reason: 'Again' }, 409)).message).toBe('The receipt was reversed already.')
    // The order takes goods again.
    expect((await ok('manager', 'GET', `/inventory/receipts/expected?purchaseOrderId=${order.id}`)).lines).toMatchObject([{ open: '200.0000', received: '0.0000' }])
  })

  it('is refused while some of its stock is issued to a work order, saying what to do; allowed once the issue is undone', async () => {
    const { receipt, hides } = await twoHides()
    const lotId = receipt.lines[0].lots[0].id
    // The quality step's release (B-W1-34), as its command would leave the lot: Cr VI PASS, RELEASED.
    await admin(`UPDATE "Lot" SET "crViStatus" = 'PASS', "crViMgKg" = 1.2, "crViEvidence" = 'LOT_REPORT', "crViTestedAt" = current_date, "qualityStatus" = 'RELEASED', "qualityDecidedAt" = now() WHERE id = $1`, [lotId])
    const issued = await ok('warehouse', 'POST', `/inventory/picking/work-orders/${A.workOrder}/issue`, { hideId: hides[0]!.id, overIssueReason: 'Test: cut a sample' }, 201, freshKey())

    const view = (await ok('manager', 'GET', `/inventory/receipts/${receipt.id}`)).receipt
    const words = `hide ${hides[0]!.code} is issued to work order SEED-WO-0001: return it to A1-RCV or reverse the issue first, then reverse the receipt.`
    expect(view.reversal).toEqual({
      possible: false,
      location: 'A1-RCV',
      // The screen's own words name the hide and the work order from these (never the English message).
      blockers: [{ code: 'ISSUED', path: 'blockers/ISSUED', message: words, where: 'SEED-WO-0001', items: [{ kind: 'HIDE', code: hides[0]!.code }] }],
    })
    const error = await refused('manager', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: view.version, reason: 'Wrong supplier' }, 409)
    expect(error).toMatchObject({ code: 'conflict', message: `The receipt's stock was used since it was posted. ${words}`, issues: [{ path: 'blockers/ISSUED', message: words }] })
    expect((await ok('viewer', 'GET', `/inventory/receipts/${receipt.id}`)).receipt).toMatchObject({ status: 'POSTED', version: view.version })
    expect(await admin(`SELECT "qualityStatus"::text AS status FROM "Lot" WHERE id = $1`, [lotId])).toEqual([{ status: 'RELEASED' }])

    // Undone, the issue sums to nothing: the receipt reverses, and its released lot ends REJECTED (RELEASED → BLOCKED → REJECTED).
    await ok('warehouse', 'POST', `/inventory/picking/issues/${issued.issue.id}/undo`, undefined, 201, freshKey())
    const answer = await ok('manager', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: view.version, reason: 'Wrong supplier' }, 201, freshKey())
    expect(answer.receipt.status).toBe('REVERSED')
    expect(answer.receipt.lines[0].lots[0].qualityStatus).toBe('REJECTED')
    for (const hide of hides) expect(await onHand(A.dock, { hideId: hide.id })).toBe('0.0000')
  })

  it('the tiles count what the list shows: posted, posted since the start of the day, waiting for quality, reversed', async () => {
    const before = (await ok('manager', 'GET', '/inventory/receipts/counts')).counts
    const walled = { companyB: (await ok('companyB', 'GET', '/inventory/receipts/counts')).counts, otherTenant: (await ok('otherTenant', 'GET', '/inventory/receipts/counts')).counts }
    const { receipt } = await twoHides()
    const startOfDay = new Date(Date.now() - 60_000).toISOString()
    const after = (await ok('manager', 'GET', `/inventory/receipts/counts?postedFrom=${encodeURIComponent(startOfDay)}`)).counts
    expect(after).toMatchObject({ posted: before.posted + 1, reversed: before.reversed })
    expect(after.postedSince).toBeGreaterThanOrEqual(1)
    expect(before.postedSince).toBeNull()
    const since = (await ok('manager', 'GET', `/inventory/receipts?postedFrom=${encodeURIComponent(startOfDay)}&limit=200`)).receipts as Json[]
    expect(since.map((row) => row.id)).toContain(receipt.id)
    expect(since).toHaveLength(after.postedSince)
    // Its lot waits for its Cr VI result: "waiting" lists it, and only posted receipts with a lot in quarantine.
    const waiting = (await ok('manager', 'GET', '/inventory/receipts?waiting=true&limit=200')).receipts as Json[]
    expect(waiting.map((row) => row.id)).toContain(receipt.id)
    expect(waiting).toHaveLength(after.waiting)
    expect(waiting.every((row) => row.status === 'POSTED' && row.lotsReleased < row.lots)).toBe(true)
    // Another company's office and another tenant count none of it.
    for (const session of ['companyB', 'otherTenant'] as const) expect((await ok(session, 'GET', '/inventory/receipts/counts')).counts).toEqual(walled[session])
  })

  it('is refused while some of it lies at another location (move it back first)', async () => {
    const { receipt, hides } = await twoHides()
    const moved = await call('warehouse', 'POST', '/inventory/transfers', { siteId: A.siteA1, itemId: A.leather, hideId: hides[1]!.id, quantity: '98', fromLocationId: A.dock, toLocationId: A.store }, freshKey())
    expect(moved.statusCode, moved.body).toBe(201)
    const error = await refused('manager', 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: receipt.version, reason: 'Wrong supplier' }, 409)
    expect(error.issues).toEqual([{ path: 'blockers/MOVED', message: `hide ${hides[1]!.code} lies at A1-STORE: move it back to A1-RCV first, then reverse the receipt.` }])
  })
})

// ---- a cancel and a receipt at once ------------------------------------------------------------------------------------------------

describe('a cancel and a receipt of one order: exactly one wins', () => {
  const protectors = () => makeOrder('SENT', [{ itemId: A.protector, colourId: null, quantity: '24', uom: 'PCS', unitPrice: '6.500000' }])
  const cancel = async (orderId: string, version?: number) => call('buyer', 'POST', `/purchasing/orders/${orderId}/cancel`, { version: version ?? (await orderOf(orderId)).version, reason: 'Not needed any more' })
  const receiveAll = (order: { id: string; lines: string[] }) => receive({ purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '24' }] }] })

  it('one after the other, both ways: a received order is never cancelled, a cancelled one never received', async () => {
    const first = await protectors()
    const version = (await orderOf(first.id)).version
    expect((await receiveAll(first)).statusCode).toBe(201)
    // Decided on the version it read before the receipt: stale. Read again: received, so never cancelled.
    expect((await cancel(first.id, version)).statusCode).toBe(409)
    const again = await cancel(first.id)
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toMatch(/Goods were received against this order/)

    const second = await protectors()
    expect((await cancel(second.id)).statusCode).toBe(200)
    const late = await receiveAll(second)
    expect(late.statusCode).toBe(409)
    expect(late.json().error.message).toBe('The order is cancelled: no goods are received against it.')
    expect(await receiptsOf(second.id)).toBe(0)
  })

  it('raced: exactly one answers 2xx, and the order is wholly received or wholly cancelled', async () => {
    for (let round = 0; round < 3; round++) {
      const order = await protectors()
      const version = (await orderOf(order.id)).version
      const [cancelled, received] = await Promise.all([cancel(order.id, version), receiveAll(order)])
      const wins = [cancelled.statusCode === 200, received.statusCode === 201].filter(Boolean).length
      expect(wins, `${cancelled.body} ${received.body}`).toBe(1)
      expect([cancelled.statusCode, received.statusCode].filter((status) => status >= 400)).toEqual([409])
      const state = await orderOf(order.id)
      if (received.statusCode === 201) {
        expect(state.status).toBe('RECEIVED')
        expect(await receiptsOf(order.id)).toBe(1)
      } else {
        expect(state.status).toBe('CANCELLED')
        expect(await receiptsOf(order.id)).toBe(0)
      }
    }
  })

  it('a cancel waits for a receipt in flight that holds the order\'s receiving lock (a floor receipt, which cannot move the order), then refuses', async () => {
    const order = await protectors()
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const holder = asOffice(async (tx) => {
      await lockOrderReceiving(tx, A.tenant, order.id)
      await tx.goodsReceipt.create({ data: { id: newId(), companyId: A.companyA, siteId: A.siteA1, number: `T-GR-FLOOR-${run}`, supplierId: A.supplier, purchaseOrderId: order.id, receivedAt: new Date() }, select: { id: true } })
      locked()
      await released
    })
    await holding
    const cancelled = cancel(order.id)
    for (let tries = 0; ; tries++) {
      const [row] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      if (row!.n >= 1) break
      if (tries > 250) throw new Error('the cancel never waited for the receiving lock')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    release()
    await holder
    const answer = await cancelled
    expect(answer.statusCode, answer.body).toBe(409)
    expect(answer.json().error.message).toBe(`Goods were received against this order (T-GR-FLOOR-${run}): it is closed, never cancelled. Reverse a wrong receipt first.`)
    expect((await orderOf(order.id)).status).toBe('SENT')
  })
})

// ---- who may ------------------------------------------------------------------------------------------------------------------------

describe('the walls: office only, the caller\'s companies and sites, its tenant', () => {
  let receipt: Json
  let order: Awaited<ReturnType<typeof makeOrder>>
  beforeAll(async () => {
    order = await makeOrder('SENT', [{ itemId: A.lining, colourId: A.liningGRY, quantity: '30', uom: 'M', unitPrice: '3.000000' }])
    receipt = (await ok('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '10' }] }] }, 201)).receipt
  })
  const body = () => ({ purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '5' }] }] })

  it('a floor device reads and records nothing here (it receives through /inventory/receiving, B-W1-33)', async () => {
    expect((await call('floor', 'GET', '/inventory/receipts')).statusCode).toBe(403)
    expect((await call('floor', 'GET', `/inventory/receipts/${receipt.id}`)).statusCode).toBe(403)
    expect((await call('floor', 'POST', '/inventory/receipts', body(), freshKey())).statusCode).toBe(403)
  })

  it('a viewer reads but does not record; another company\'s office and another tenant see nothing', async () => {
    expect((await ok('viewer', 'GET', `/inventory/receipts/${receipt.id}`)).receipt.id).toBe(receipt.id)
    expect((await refused('viewer', 'POST', '/inventory/receipts', body(), 403)).code).toBe('forbidden')
    for (const session of ['companyB', 'otherTenant']) {
      expect((await call(session, 'GET', `/inventory/receipts/${receipt.id}`)).statusCode).toBe(404)
      expect((await call(session, 'GET', `/inventory/receipts/${receipt.id}/lots`)).statusCode).toBe(404)
      expect((await ok(session, 'GET', '/inventory/receipts')).receipts.map((row: Json) => row.id)).not.toContain(receipt.id)
      expect((await refused(session, 'POST', '/inventory/receipts', body(), 404)).message).toBe('Purchase order not found.')
      expect((await refused(session, 'POST', `/inventory/receipts/${receipt.id}/reverse`, { version: receipt.version, reason: 'Not mine' }, 404)).message).toBe('Goods receipt not found.')
      expect((await ok(session, 'GET', `/inventory/receipts/expected?purchaseOrderId=${order.id}`)).lines).toEqual([])
    }
    expect(await receiptsOf(order.id)).toBe(1)
  })
})
