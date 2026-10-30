import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { valueMove } from '../ledger/valuation'

/**
 * Receiving goods on the floor (B-W1-33; SCM-113, SCM-116, SCM-117, SCM-247, SCM-259, SCM-268; A2 SCR-092; receipts notes
 * gaps 1, 4, 5) on the local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security, the floor's column grants and the …_supply_guards triggers are real), the factory-db
 * seeds of two tenants up to production plus numbering (each company's GOODS_RECEIPT and LOT series), and a made-up label
 * printer LBL-01 on site A1's cutting station CUT-01, where the seeded tablet stands. The tablet's sessions come from
 * the test authenticator; purchase orders to the seeded supplier P2 are made up here. Every name, number and price is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs receiving`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'receiving-a', b: 'receiving-b' } as const
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
  hold: idOf(ns.a, 'inventory:location:A1-QUA'),
  printer: newId(),
  cuttingStation: idOf(ns.a, 'site:A1:station:CUT-01'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  deviceB1: idOf(ns.a, 'device:B1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant'), siteA1: idOf(ns.b, 'site:A1'), companyA: idOf(ns.b, 'company:A'), deviceA1: idOf(ns.b, 'device:A1:cutting') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const RECEIVER: Permission[] = ['floor.work', 'inventory.receive', 'inventory.locations.view', 'print.view', 'print.labels']
const tablet = (tenantId: string, siteId: string, deviceId: string, companyId: string, permissions: Permission[]): SessionContext => ({
  audience: 'floor',
  tenantId,
  actorId: A.operatorA1,
  siteId,
  deviceId,
  grants: [grant(permissions, [companyId], [siteId])],
})
const SESSIONS: Record<string, SessionContext> = {
  /** The goods-in tablet at site A1 with the receiving floor role (the operator's template). */
  floor: tablet(A.tenant, A.siteA1, A.deviceA1, A.companyA, RECEIVER),
  /** A tablet whose person may pick but not receive. */
  picker: tablet(A.tenant, A.siteA1, A.deviceA1, A.companyA, ['floor.work', 'inventory.issue', 'print.labels']),
  /** A tablet of site B1 (company B). */
  floorB1: tablet(A.tenant, A.siteB1, A.deviceB1, A.companyB, RECEIVER),
  /** A tablet of another tenant. */
  otherTenant: tablet(B.tenant, B.siteA1, B.deviceA1, B.companyA, RECEIVER),
  manager: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['inventory.receive', 'inventory.stock.view', 'inventory.reverse', 'money.cost'])] },
  buyer: { audience: 'office', tenantId: A.tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'purchasing.send'])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const freshKey = () => `fr-${run}-${++counter}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? (method === 'POST' ? freshKey() : undefined))
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const orderOf = async (id: string) => (await admin<{ status: string; version: number }>('SELECT status::text AS status, version FROM "PurchaseOrder" WHERE id = $1', [id]))[0]!
const receiptsOf = async (orderId: string) => (await admin<{ n: number }>('SELECT count(*)::int AS n FROM "GoodsReceipt" WHERE "purchaseOrderId" = $1', [orderId]))[0]!.n
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const moneyKeys = (value: unknown) => keysOf(value).filter((key) => /value|cost|price|amount/i.test(key))

interface LineSpec {
  readonly itemId: string
  readonly colourId: string | null
  readonly quantity: string
  readonly uom: string
  readonly unitPrice: string
  readonly tolerancePct?: string
  readonly estimatedHides?: number
  readonly requiresCrViTest?: boolean
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
         "areaTolerancePct", "estimatedHides", "requiresCrViTest")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $9, $11, $12, current_date + 20, $13, $14, $15)`,
      [lineId, A.tenant, id, A.supplier, A.siteA1, (index + 1) * 10, line.itemId, line.colourId, line.quantity, line.uom, line.unitPrice, amount, line.tolerancePct ?? null, line.estimatedHides ?? null, line.requiresCrViTest ?? false],
    )
  }
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = $3, version = 2 WHERE id = $1`, [id, A.actor, total])
  if (status === 'CONFIRMED') await admin(`UPDATE "PurchaseOrder" SET status = 'CONFIRMED', "confirmedAt" = now(), "confirmedVia" = 'OFFICE', version = 3 WHERE id = $1`, [id])
  return { id, number, lines: lineIds }
}
const leatherLine = (quantity: string): LineSpec => ({ itemId: A.leather, colourId: A.leatherBLK, quantity, uom: 'FT2', unitPrice: '5.000000', tolerancePct: '5', estimatedHides: 4, requiresCrViTest: true })
const protectorLine = (quantity: string): LineSpec => ({ itemId: A.protector, colourId: null, quantity, uom: 'PCS', unitPrice: '6.500000' })
const floorReceive = (orderId: string, body: Json, session = 'floor', key: string | undefined = freshKey()) => call(session, 'POST', `/inventory/receiving/orders/${orderId}/receipts`, body, key)

beforeAll(async () => {
  db = await migratedDatabase('receiving')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  // A made-up label printer at A1 (203 dpi, 100 × 100 mm, FAKE relay) on the tablet's station (MES-184).
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-01', 'Made-up tag printer', 'LABEL_ZPL', 'FAKE', 'test-tag-printer:9100', 203, 100, 100)`,
    [A.printer, A.tenant, A.companyA, A.siteA1],
  )
  await admin(`UPDATE "Station" SET "labelPrinterId" = $1 WHERE id = $2`, [A.printer, A.cuttingStation])
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

describe('a goods-in tablet receives a delivery: hides one by one and a lot, held for quality, tags printed, the order moved on', () => {
  let order: Awaited<ReturnType<typeof makeOrder>>
  let receipt: Json
  let key: string

  beforeAll(async () => {
    // 200 ft² of black cowhide (± 5%, about 4 hides, Cr VI tested) and 24 certified shoulder protectors.
    order = await makeOrder('CONFIRMED', [leatherLine('200'), protectorLine('24')])
  })

  it('finds what the site expects, by the list or by the scanned number, without a price', async () => {
    const list = await ok('floor', 'GET', '/inventory/receiving/orders')
    const mine = (list.orders as Json[]).find((row) => row.id === order.id)
    expect(mine).toMatchObject({ number: order.number, status: 'CONFIRMED', supplier: { id: A.supplier }, openLines: 2, lines: 2, receivedBefore: false })
    expect(mine!.supplier.name).not.toBe('')
    expect(list.found).toBeNull()
    const scanned = await ok('floor', 'GET', `/inventory/receiving/orders?code=${encodeURIComponent(order.number.toLowerCase())}`)
    expect(scanned.orders.map((row: Json) => row.id)).toEqual([order.id])
    expect(scanned.found).toEqual({ id: order.id, number: order.number, status: 'CONFIRMED' })
    const unknown = await ok('floor', 'GET', '/inventory/receiving/orders?code=DDT-4512')
    expect(unknown).toMatchObject({ orders: [], found: null })

    const view = await ok('floor', 'GET', `/inventory/receiving/orders/${order.id}`)
    expect(view.order).toMatchObject({ id: order.id, number: order.number, status: 'CONFIRMED', version: 3 })
    expect(view.refusal).toBeNull()
    expect(view.lines).toEqual([
      expect.objectContaining({ seq: 10, uom: 'FT2', expected: '200.0000', received: '0.0000', open: '200.0000', upTo: '210.0000', tolerancePct: '5', estimatedHides: 4, hidesReceived: 0, holds: ['CR_VI_TEST'], areaUnits: ['FT2', 'M2', 'DM2'] }),
      expect.objectContaining({ seq: 20, uom: 'PCS', expected: '24.0000', open: '24.0000', holds: ['PPE_CERTIFICATE'], areaUnits: [] }),
    ])
    expect(view.lines[0].item).toMatchObject({ tracking: 'HIDE', baseUom: 'FT2' })
    expect(view.dock).toMatchObject({ id: A.dock, code: 'A1-RCV' })
    expect(view.hold).toMatchObject({ id: A.hold, code: 'A1-QUA' })
    expect(view.printer).toMatchObject({ id: A.printer, code: 'LBL-01' })
    expect(moneyKeys(list)).toEqual([])
    expect(moneyKeys(view)).toEqual([])
  })

  it('posts the receipt: numbers from the series, the tenant\'s hide tags, lots in quarantine on the hold rack, tags queued, PARTLY_RECEIVED', async () => {
    key = freshKey()
    const response = await floorReceive(
      order.id,
      {
        version: 3,
        supplierDdtNumber: 'DDT-T-0101',
        supplierDdtDate: '2026-10-29',
        language: 'en',
        lines: [
          { purchaseOrderLineId: order.lines[0], lots: [{ supplierLotRef: 'TAN-881', dyeBatch: 'DB-7', hides: [{ supplierCode: 'T-01', area: '52.3', grade: 'A', thicknessMm: '1.2' }, { supplierCode: 'T-02', area: '48.9', grade: 'A' }, { supplierCode: 'T-03', area: '4.8', areaUom: 'M2', grade: 'B', defects: 'Scar' }] }] },
          { purchaseOrderLineId: order.lines[1], lots: [{ supplierLotRef: 'PRT-12', quantity: '10' }] },
        ],
      },
      'floor',
      key,
    )
    expect(response.statusCode, response.body).toBe(201)
    const answer = response.json()
    receipt = answer.receipt
    expect(receipt.number).toMatch(/^GR-\d{4}-\d{4}$/)
    expect(receipt).toMatchObject({ status: 'POSTED', supplierDdtNumber: 'DDT-T-0101', order: { id: order.id, status: 'PARTLY_RECEIVED', version: 4 } })
    expect(receipt.lots).toHaveLength(2)
    expect(receipt.lots.every((lot: Json) => /^LA-\d{6}$/.test(lot.code) && lot.qualityStatus === 'QUARANTINE' && lot.location.id === A.hold)).toBe(true)
    expect(receipt.lots.map((lot: Json) => lot.holds).sort()).toEqual([['CR_VI_TEST'], ['PPE_CERTIFICATE']])
    // 52.3 + 48.9 ft² and 4.8 m² = 51.6668 ft².
    expect(receipt.lines.map((line: Json) => [line.seq, line.baseQuantity, line.difference.kind])).toEqual([[10, '152.8668', 'SHORT'], [20, '10.0000', 'SHORT']])
    const tag = tenantTag(A.tenant)
    expect(receipt.hides).toHaveLength(3)
    expect(receipt.hides.every((hide: Json) => parseScanId(hide.code, { types: ['HIDE'], tenantTag: tag }).ok)).toBe(true)
    expect(receipt.tags.printer).toMatchObject({ id: A.printer })
    expect(receipt.tags.jobs).toHaveLength(3)
    expect(receipt.tags.jobs.every((job: Json) => job.status === 'QUEUED' && job.jobId !== null && job.problem === null)).toBe(true)
    expect(answer.notes.map((note: Json) => note.code)).toEqual(['SHORT', 'HIDE_COUNT', 'SHORT', 'QUARANTINE', 'QUARANTINE'])
    expect(moneyKeys(answer)).toEqual([])

    // The ledger: 4 RECEIPT moves on the hold rack, posted by the tablet's person with its device, not valued yet.
    const moves = await admin<{ n: number; place: string; by: string; device: string }>(
      `SELECT count(*)::int AS n, min(m."toLocationId"::text) AS place, min(m."createdById"::text) AS by, min(m."deviceId"::text) AS device
         FROM "StockMove" m JOIN "GoodsReceiptLine" l ON l.id = m."receiptLineId" WHERE l."receiptId" = $1`,
      [receipt.id],
    )
    expect(moves).toEqual([{ n: 4, place: A.hold, by: A.operatorA1, device: A.deviceA1 }])
    expect(await admin(`SELECT count(*)::int AS n FROM "StockValuation" v JOIN "StockMove" m ON m.id = v."moveId" JOIN "GoodsReceiptLine" l ON l.id = m."receiptLineId" WHERE l."receiptId" = $1`, [receipt.id])).toEqual([{ n: 0 }])
    // The numbers: the receipt's and lots' from the company's series, allocated by the tablet.
    expect(await admin(`SELECT kind::text AS kind, count(*)::int AS n, min("allocatedById"::text) AS by FROM "NumberAllocation" WHERE "recordId" = ANY($1::uuid[]) GROUP BY 1 ORDER BY 1`, [[receipt.id, ...receipt.lots.map((lot: Json) => lot.id)]])).toEqual([
      { kind: 'GOODS_RECEIPT', n: 1, by: A.deviceA1 },
      { kind: 'LOT', n: 2, by: A.deviceA1 },
    ])
    // The order moved in the system context, audited on the order; the receipt's own rows name the tablet's person.
    expect(await admin(`SELECT action, before->>'status' AS before, after->>'status' AS after, after->>'receiptNumber' AS number FROM "AuditLog" WHERE "recordType" = 'PurchaseOrder' AND "recordId" = $1`, [order.id])).toEqual([
      { action: 'purchasing.received', before: 'CONFIRMED', after: 'PARTLY_RECEIVED', number: receipt.number },
    ])
    expect(await admin(`SELECT "createdById"::text AS by, "postedById"::text AS posted FROM "GoodsReceipt" WHERE id = $1`, [receipt.id])).toEqual([{ by: A.operatorA1, posted: A.operatorA1 }])
    expect(await admin(`SELECT count(*)::int AS n FROM "PrintJob" WHERE "recordType" = 'Hide' AND "recordId" = ANY($1::uuid[]) AND "printerId" = $2 AND "labelKind" = 'HIDE'`, [receipt.hides.map((hide: Json) => hide.id), A.printer])).toEqual([{ n: 3 }])
    expect(await admin(`SELECT type, payload->>'postedBy' AS by FROM "OutboxEvent" WHERE subject = $1`, [receipt.id])).toEqual([{ type: 'inventory.receipt_posted', by: 'FLOOR' }])
  })

  it('a resend of the same request answers the same receipt: nothing posted, numbered or printed twice', async () => {
    const again = await floorReceive(order.id, { version: 3, supplierDdtNumber: 'DDT-T-0101', supplierDdtDate: '2026-10-29', language: 'en', lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ supplierLotRef: 'TAN-881', dyeBatch: 'DB-7', hides: [{ supplierCode: 'T-01', area: '52.3', grade: 'A', thicknessMm: '1.2' }, { supplierCode: 'T-02', area: '48.9', grade: 'A' }, { supplierCode: 'T-03', area: '4.8', areaUom: 'M2', grade: 'B', defects: 'Scar' }] }] }, { purchaseOrderLineId: order.lines[1], lots: [{ supplierLotRef: 'PRT-12', quantity: '10' }] }] }, 'floor', key)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().receipt.id).toBe(receipt.id)
    expect(await receiptsOf(order.id)).toBe(1)
    expect(await orderOf(order.id)).toEqual({ status: 'PARTLY_RECEIVED', version: 4 })
    expect(await admin(`SELECT count(*)::int AS n FROM "PrintJob" WHERE "recordType" = 'Hide' AND "recordId" = ANY($1::uuid[])`, [receipt.hides.map((hide: Json) => hide.id)])).toEqual([{ n: 3 }])
  })

  it('the worker values the floor\'s moves at the order line\'s price, as an office receipt would', async () => {
    const moves = await admin<{ id: string }>(`SELECT m.id::text AS id FROM "StockMove" m JOIN "GoodsReceiptLine" l ON l.id = m."receiptLineId" WHERE l."receiptId" = $1`, [receipt.id])
    const system = callerFor(database, systemContext(A.tenant, newId()))
    for (const move of moves) expect(await valueMove(system, move.id, newId())).toBe(true)
    expect(
      await admin(`SELECT v.method::text AS method, v."unitCost"::text AS cost, count(*)::int AS n FROM "StockValuation" v JOIN "StockMove" m ON m.id = v."moveId" JOIN "GoodsReceiptLine" l ON l.id = m."receiptLineId" WHERE l."receiptId" = $1 GROUP BY 1, 2 ORDER BY 2`, [receipt.id]),
    ).toEqual([
      { method: 'PURCHASE_PRICE', cost: '5.000000', n: 3 },
      { method: 'PURCHASE_PRICE', cost: '6.500000', n: 1 },
    ])
    // The office sees the receipt with its number and its value (the cost grain).
    const office = await ok('manager', 'GET', `/inventory/receipts/${receipt.id}`)
    expect(office.receipt).toMatchObject({ number: receipt.number, status: 'POSTED', purchaseOrder: { id: order.id, status: 'PARTLY_RECEIVED' } })
    // 152.8668 ft² × 5.00 = 764.33 and 10 × 6.50 = 65.00.
    expect(office.receipt.value).toEqual({ currency: 'EUR', valueAmount: 82_933 })
  })

  it('a reprint logs its reason on each hide and queues a new tag; the order line shows what came', async () => {
    const hide = receipt.hides[0]
    const answer = await ok('floor', 'POST', `/inventory/receiving/receipts/${receipt.id}/tags`, { hideIds: [hide.id], reason: 'DAMAGED' })
    const job = answer.receipt.tags.jobs.find((entry: Json) => entry.hideId === hide.id)
    expect(job.jobId).not.toBe(receipt.tags.jobs.find((entry: Json) => entry.hideId === hide.id).jobId)
    expect(await admin(`SELECT reason FROM "AuditLog" WHERE action = 'inventory.hideTagReprinted' AND "recordId" = $1`, [hide.id])).toEqual([{ reason: 'The tag was damaged.' }])
    const view = await ok('floor', 'GET', `/inventory/receiving/orders/${order.id}`)
    expect(view.lines[0]).toMatchObject({ received: '152.8668', open: '47.1332', upTo: '57.1332', hidesReceived: 3 })
    expect((await ok('floor', 'GET', `/inventory/receiving/receipts/${receipt.id}`)).receipt.id).toBe(receipt.id)
  })
})

describe('what a floor receipt refuses, writing nothing', () => {
  it('an order changed since the screen read it (409 body/version), more than the tolerance without a reason, an order that takes no goods', async () => {
    const order = await makeOrder('SENT', [leatherLine('100')])
    const hides = [{ area: '60' }, { area: '50' }]
    const stale = await floorReceive(order.id, { version: 1, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ hides }] }] })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.issues).toEqual([{ path: 'body/version', message: 'Read the order again.' }])
    const over = await floorReceive(order.id, { version: 2, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ hides }] }] })
    expect(over.statusCode, over.body).toBe(409)
    expect(over.json().error.issues[0].path).toBe('body/lines/0/differenceReason')
    expect(await receiptsOf(order.id)).toBe(0)
    expect(await orderOf(order.id)).toEqual({ status: 'SENT', version: 2 })
    // With the reason it is taken.
    expect((await floorReceive(order.id, { version: 2, printerId: null, lines: [{ purchaseOrderLineId: order.lines[0], differenceReason: 'The tannery sent a larger hide.', lots: [{ hides }] }] })).statusCode).toBe(201)
    expect(await orderOf(order.id)).toEqual({ status: 'RECEIVED', version: 3 })
    const after = await floorReceive(order.id, { version: 3, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ hides: [{ area: '1' }] }] }] })
    expect(after.statusCode, after.body).toBe(409)
    expect(after.json().error.code).toBe('invalid_state')
  })
})

describe('a floor receipt and an office cancel of one order: exactly one wins', () => {
  const protectors = () => makeOrder('SENT', [protectorLine('24')])
  const cancel = (orderId: string, version: number) => call('buyer', 'POST', `/purchasing/orders/${orderId}/cancel`, { version, reason: 'Not needed any more' })
  const receiveAll = (order: { id: string; lines: string[] }) => floorReceive(order.id, { version: 2, printerId: null, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '24' }] }] })

  it('one after the other, both ways: a received order is never cancelled, a cancelled one never received', async () => {
    const first = await protectors()
    expect((await receiveAll(first)).statusCode).toBe(201)
    const late = await cancel(first.id, (await orderOf(first.id)).version)
    expect(late.statusCode, late.body).toBe(409)
    expect(late.json().error.message).toMatch(/^Goods were received against this order/)
    expect((await orderOf(first.id)).status).toBe('RECEIVED')

    const second = await protectors()
    expect((await cancel(second.id, 2)).statusCode).toBe(200)
    const refused = await floorReceive(second.id, { version: 3, printerId: null, lines: [{ purchaseOrderLineId: second.lines[0], lots: [{ quantity: '24' }] }] })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.message).toBe('The order is cancelled: no goods are received against it.')
    expect(await receiptsOf(second.id)).toBe(0)
  })

  it('raced: exactly one answers 2xx; the order is wholly received or wholly cancelled', async () => {
    for (let round = 0; round < 4; round++) {
      const order = await protectors()
      const [cancelled, received] = await Promise.all([cancel(order.id, 2), receiveAll(order)])
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
})

describe('the walls: inventory.receive at the tablet\'s own site, its tenant; the office routes stay the office\'s', () => {
  let order: Awaited<ReturnType<typeof makeOrder>>
  beforeAll(async () => {
    order = await makeOrder('SENT', [{ itemId: A.lining, colourId: A.liningGRY, quantity: '30', uom: 'M', unitPrice: '3.000000' }])
  })
  const body = () => ({ version: 2, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity: '5' }] }] })

  it('a tablet without inventory.receive reads and records nothing (403)', async () => {
    expect((await call('picker', 'GET', '/inventory/receiving/orders')).statusCode).toBe(403)
    expect((await call('picker', 'GET', `/inventory/receiving/orders/${order.id}`)).statusCode).toBe(403)
    expect((await floorReceive(order.id, body(), 'picker')).statusCode).toBe(403)
  })

  it('another site\'s tablet and another tenant\'s find nothing (404); a write needs an Idempotency-Key', async () => {
    for (const session of ['floorB1', 'otherTenant']) {
      expect((await ok(session, 'GET', '/inventory/receiving/orders')).orders.map((row: Json) => row.id)).not.toContain(order.id)
      expect((await call(session, 'GET', `/inventory/receiving/orders/${order.id}`)).statusCode).toBe(404)
      expect((await floorReceive(order.id, body(), session)).statusCode).toBe(404)
    }
    expect((await call('floor', 'POST', `/inventory/receiving/orders/${order.id}/receipts`, body())).statusCode).toBe(400)
    expect(await receiptsOf(order.id)).toBe(0)
    expect((await call('manager', 'GET', '/inventory/receiving/orders')).statusCode).toBe(403)
    expect((await call('floor', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: body().lines }, freshKey())).statusCode).toBe(403)
  })
})
