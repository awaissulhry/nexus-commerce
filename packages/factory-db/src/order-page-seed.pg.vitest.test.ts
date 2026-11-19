import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore } from '../seed/_core'
import { seed as seedOrderPage, type OrderPageSeed } from '../seed/order-page'
import { openFactoryDatabase, type FactoryDatabase } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-OP-046 (order page N6, lines-derived): the seed's shared shipment SEED-SH-0004 — a DRAFT made for SEED-SO-0002 that carries
 * a line of SEED-SO-0003 too, of the seed's OWN released garments (SEED-WO-0101 / 0102) — written through the real login and the guards (schema wave "order page 1/1": a line of another
 * open order of the same customer, company, currency and tax mode joins a DRAFT), twice (idempotent). It is on both orders by
 * the database's own helper (factory_order_shipments), and only ever of its own customer. Every name and number is made up.
 * B-OP-046 (P16): and the monthly invoice of two orders — one ISSUED TD24 of P1 billing the shipped goods of SEED-SO-0101 and
 * SEED-SO-0102 (the seed's own garments, shipments and DDTs), partly paid by one payment.
 * Run with `node scripts/factory/run-pg-tests.mjs order-page-seed`.
 */

const NS = 'op046-order-page-seed'
const tenantId = seedUuid(NS, 'tenant')
let db: MigratedDatabase
let factory: FactoryDatabase
let seeded: OrderPageSeed

type Row = Record<string, any>
const admin = async (text: string, values: unknown[] = []): Promise<Row[]> => (await db.admin.query(text, values)).rows as Row[]

beforeAll(async () => {
  db = await migratedDatabase('op046orderpageseed')
  factory = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  await seedCore({ db: factory, namespace: NS })
  seeded = await seedOrderPage({ db: factory, namespace: NS })
  // Run twice: the seed is idempotent.
  seeded = await seedOrderPage({ db: factory, namespace: NS })
}, 600_000)

afterAll(async () => {
  await factory?.close()
  await db?.close()
}, 60_000)

describe('B-OP-046: the seed holds one shipment of two orders of one customer', () => {
  it('SEED-SH-0004 is a DRAFT of SEED-SO-0002 (its first order) with one line of each order, written once', async () => {
    const [shipment] = await admin(`SELECT number, status::text AS status, "salesOrderId"::text AS "salesOrderId", "partyId"::text AS "partyId", origin::text AS origin FROM "Shipment" WHERE id = $1`, [seeded.sharedShipmentId])
    expect(shipment).toEqual({ number: 'SEED-SH-0004', status: 'DRAFT', salesOrderId: seeded.salesOrderIds[0], partyId: seedUuid(NS, 'party:P1'), origin: 'NEXUS' })
    const lines = await admin(`SELECT sl.id::text AS id, l."orderId"::text AS "orderId", sl.quantity FROM "ShipmentLine" sl JOIN "SalesOrderLine" l ON l.id = sl."salesOrderLineId" WHERE sl."shipmentId" = $1 ORDER BY sl.id`, [seeded.sharedShipmentId])
    expect(lines.map((line) => line.id).sort()).toEqual([...seeded.lineIds].sort())
    expect(new Set(lines.map((line) => line.orderId))).toEqual(new Set(seeded.salesOrderIds))
    expect(lines.every((line) => line.quantity === 1)).toBe(true)
  })

  it('is on both orders by factory_order_shipments, and every order it carries is its own customer\'s', async () => {
    for (const orderId of seeded.salesOrderIds) {
      const rows = await admin(`SELECT shipment_id::text AS id FROM factory_order_shipments($1::uuid, $2::uuid)`, [tenantId, orderId])
      expect(rows.map((row) => row.id), orderId).toContain(seeded.sharedShipmentId)
    }
    const parties = await admin(`SELECT DISTINCT o."partyId"::text AS "partyId" FROM "ShipmentLine" sl JOIN "SalesOrderLine" l ON l.id = sl."salesOrderLineId" JOIN "SalesOrder" o ON o.id = l."orderId" WHERE sl."shipmentId" = $1`, [seeded.sharedShipmentId])
    expect(parties).toEqual([{ partyId: seedUuid(NS, 'party:P1') }])
  })

  it('is self-contained: its own two garments (released 1, on it 1); the other seeds\' garments keep what they can ship', async () => {
    const shippable = async (cellId: string): Promise<{ released: number; onShipments: number }> =>
      (
        await admin(
          `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM "QualityRelease" WHERE "workOrderSizeId" = $1)::int
                - (SELECT COALESCE(SUM(quantity), 0) FROM "QualityReleaseReversal" WHERE "workOrderSizeId" = $1)::int AS released,
                  (SELECT COALESCE(SUM(sl.quantity), 0) FROM "ShipmentLine" sl JOIN "Shipment" s ON s.id = sl."shipmentId" WHERE sl."workOrderSizeId" = $1 AND s.status::text <> 'CANCELLED')::int AS "onShipments"`,
          [cellId],
        )
      )[0] as { released: number; onShipments: number }
    for (const cellId of seeded.cellIds) expect(await shippable(cellId), cellId).toEqual({ released: 1, onShipments: 1 })
    // The shipping seed's own garments: SEED-WO-0001's BLK 52 and SEED-WO-0003's jacket still have one each to ship.
    const [blk52] = await admin(
      `SELECT c.id::text AS id FROM "WorkOrderSize" c JOIN "WorkOrder" w ON w.id = c."workOrderId" JOIN "Colourway" k ON k.id = c."colourwayId"
        WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0001' AND k.code = 'BLK' AND c.size = '52'`,
      [tenantId],
    )
    const [jacket] = await admin(`SELECT c.id::text AS id FROM "WorkOrderSize" c JOIN "WorkOrder" w ON w.id = c."workOrderId" WHERE w."tenantId" = $1 AND w.number = 'SEED-WO-0003'`, [tenantId])
    for (const cell of [blk52!, jacket!]) {
      const counts = await shippable(cell.id)
      expect(counts.released - counts.onShipments, cell.id).toBe(1)
    }
    // Its own work orders: SEED-WO-0101 / 0102, completed, one garment each, inspected and released.
    expect(await admin(`SELECT number, status::text AS status FROM "WorkOrder" WHERE id = ANY($1::uuid[]) ORDER BY number`, [[...seeded.workOrderIds]])).toEqual([
      { number: 'SEED-WO-0101', status: 'COMPLETED' },
      { number: 'SEED-WO-0102', status: 'COMPLETED' },
    ])
  })
})

// ---- B-OP-046 (P16): the monthly invoice of two orders (order page plan N3, B-OP-022) --------------------------------------------
describe('B-OP-046 (P16): the seed holds one ISSUED TD24 that bills two orders of one customer, partly paid', () => {
  const P1 = () => seedUuid(NS, 'party:P1')

  it('the TD24 exists once, ISSUED with the INVOICE series\' next number after the money seed\'s, and names no order of its own', async () => {
    const issued = await admin(`SELECT id::text AS id FROM "Invoice" WHERE "tenantId" = $1 AND "docType" = 'TD24' AND status::text <> 'DRAFT'`, [tenantId])
    expect(issued).toEqual([{ id: seeded.monthly.invoiceId }])
    const [invoice] = await admin(
      `SELECT number, status::text AS status, "issueDate"::text AS "issueDate", "salesOrderId", "buyerPartyId"::text AS buyer, "partyId"::text AS party,
              "netTotal", "vatTotal", "grossTotal", "xmlFileId", (SELECT count(*)::int FROM "NumberAllocation" a WHERE a."recordType" = 'Invoice' AND a."recordId" = i.id) AS allocations
         FROM "Invoice" i WHERE id = $1`,
      [seeded.monthly.invoiceId],
    )
    expect(invoice).toEqual({ number: 'FT-2026-00004', status: 'ISSUED', issueDate: '2026-10-31', salesOrderId: null, buyer: P1(), party: P1(), netTotal: 120000, vatTotal: 26400, grossTotal: 146400, xmlFileId: null, allocations: 1 })
    const [series] = await admin(`SELECT "nextValue" FROM "NumberSeries" WHERE "tenantId" = $1 AND kind = 'INVOICE' AND code = 'MAIN' AND "scopeKey" = '2026' AND "companyId" = $2`, [tenantId, seedUuid(NS, 'company:A')])
    expect(series).toEqual({ nextValue: 5 })
  })

  it('bills the shipped goods of two orders of P1, each line with its own order line and its issued Nexus DDT', async () => {
    const lines = await admin(
      `SELECT l.seq, l.kind::text AS kind, l.quantity::text AS quantity, l."netAmount", o.id::text AS "orderId", o.number AS "order", o.status::text AS "orderStatus", o."partyId"::text AS party,
              d.id::text AS "ddtId", d.number AS ddt, d."documentDate"::text AS "ddtDate", s.status::text AS shipment,
              EXISTS (SELECT 1 FROM "DdtCancellation" x WHERE x."ddtId" = d.id) AS cancelled,
              EXISTS (SELECT 1 FROM "ShipmentLine" sl WHERE sl."shipmentId" = s.id AND sl."salesOrderLineId" = l."salesOrderLineId" AND sl.quantity::numeric = l.quantity) AS carried
         FROM "InvoiceLine" l JOIN "SalesOrderLine" ol ON ol.id = l."salesOrderLineId" JOIN "SalesOrder" o ON o.id = ol."orderId"
         JOIN "Ddt" d ON d.id = l."ddtId" JOIN "Shipment" s ON s.id = d."shipmentId"
        WHERE l."invoiceId" = $1 ORDER BY l.seq`,
      [seeded.monthly.invoiceId],
    )
    expect(lines.map(({ ddt, ...line }) => line)).toEqual([
      { seq: 1, kind: 'GOODS', quantity: '1.0000', netAmount: 40000, orderId: seeded.monthly.salesOrderIds[0], order: 'SEED-SO-0101', orderStatus: 'SHIPPED', party: P1(), ddtId: seeded.monthly.ddtIds[0], ddtDate: '2026-10-30', shipment: 'SHIPPED', cancelled: false, carried: true },
      { seq: 2, kind: 'GOODS', quantity: '2.0000', netAmount: 80000, orderId: seeded.monthly.salesOrderIds[1], order: 'SEED-SO-0102', orderStatus: 'SHIPPED', party: P1(), ddtId: seeded.monthly.ddtIds[1], ddtDate: '2026-10-30', shipment: 'SHIPPED', cancelled: false, carried: true },
    ])
    // The two DDTs follow each other in company A's series (the shipping seed's 143/144 before them).
    const numbers = lines.map((line) => Number(String(line.ddt).split('/')[0]))
    expect(numbers[1]).toBe(numbers[0]! + 1)
    expect(numbers[0]).toBeGreaterThan(144)
  })

  it('is partly paid: one payment placed on it whole, less than its gross', async () => {
    const placed = await admin(`SELECT a."paymentId"::text AS "paymentId", a.amount, p.amount AS "paymentAmount", p."externalRef" FROM "PaymentAllocation" a JOIN "Payment" p ON p.id = a."paymentId" WHERE a."invoiceId" = $1`, [seeded.monthly.invoiceId])
    expect(placed).toEqual([{ paymentId: seeded.monthly.paymentId, amount: 60000, paymentAmount: 60000, externalRef: 'SEED-TRN-0000101' }])
  })

  it('is self-contained: its own garments, released and shipped once each; written once (the seed ran twice)', async () => {
    for (const [index, cellId] of seeded.monthly.cellIds.entries()) {
      const [counts] = await admin(
        `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM "QualityRelease" WHERE "workOrderSizeId" = $1)::int AS released,
                (SELECT COALESCE(SUM(sl.quantity), 0) FROM "ShipmentLine" sl JOIN "Shipment" s ON s.id = sl."shipmentId" WHERE sl."workOrderSizeId" = $1 AND s.status::text <> 'CANCELLED')::int AS shipped`,
        [cellId],
      )
      expect(counts, cellId).toEqual({ released: index + 1, shipped: index + 1 })
    }
    expect(await admin(`SELECT number, status::text AS status FROM "WorkOrder" WHERE id = ANY($1::uuid[]) ORDER BY number`, [[...seeded.monthly.workOrderIds]])).toEqual([
      { number: 'SEED-WO-0103', status: 'COMPLETED' },
      { number: 'SEED-WO-0104', status: 'COMPLETED' },
    ])
    const [written] = await admin(
      `SELECT (SELECT count(*)::int FROM "SalesOrder" WHERE "tenantId" = $1 AND number IN ('SEED-SO-0101', 'SEED-SO-0102')) AS orders,
              (SELECT count(*)::int FROM "Shipment" WHERE "tenantId" = $1 AND number IN ('SEED-SH-0101', 'SEED-SH-0102')) AS shipments,
              (SELECT count(*)::int FROM "Ddt" WHERE id = ANY($2::uuid[])) AS ddts,
              (SELECT count(*)::int FROM "Payment" WHERE "tenantId" = $1 AND "externalRef" = 'SEED-TRN-0000101') AS payments`,
      [tenantId, [...seeded.monthly.ddtIds]],
    )
    expect(written).toEqual({ orders: 2, shipments: 2, ddts: 2, payments: 1 })
  })
})
// ---- end B-OP-046 (P16)
