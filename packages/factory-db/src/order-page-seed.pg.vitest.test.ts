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
