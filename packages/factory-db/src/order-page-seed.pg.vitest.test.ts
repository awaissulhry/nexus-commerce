import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seed as seedCore } from '../seed/_core'
import { seed as seedOrderPage, type OrderPageSeed } from '../seed/order-page'
import { openFactoryDatabase, type FactoryDatabase } from './client'
import { RUNTIME_LOGIN } from './roles'
import { seedUuid } from './seeding'
import { migratedDatabase, type MigratedDatabase } from './testing/database'

/**
 * B-OP-046 (order page N6, lines-derived): the seed's shared shipment SEED-SH-0004 — a DRAFT made for SEED-SO-0002 that carries
 * a line of SEED-SO-0003 too — written through the real login and the guards (schema wave "order page 1/1": a line of another
 * open order of the same customer, company, currency and tax mode joins a DRAFT), twice (idempotent). It is on both orders by
 * the database's own helper (factory_order_shipments), and only ever of its own customer. Every name and number is made up.
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

  it('the two garments it holds stay within their cells\' releases (the line guard counted them)', async () => {
    const over = await admin(
      `SELECT c.id FROM "WorkOrderSize" c
        WHERE c.id IN (SELECT "workOrderSizeId" FROM "ShipmentLine" WHERE "shipmentId" = $1)
          AND (SELECT COALESCE(SUM(quantity), 0) FROM "QualityRelease" WHERE "workOrderSizeId" = c.id) - (SELECT COALESCE(SUM(quantity), 0) FROM "QualityReleaseReversal" WHERE "workOrderSizeId" = c.id)
            < (SELECT COALESCE(SUM(sl.quantity), 0) FROM "ShipmentLine" sl JOIN "Shipment" s ON s.id = sl."shipmentId" WHERE sl."workOrderSizeId" = c.id AND s.status::text <> 'CANCELLED')`,
      [seeded.sharedShipmentId],
    )
    expect(over).toEqual([])
  })
})
