import type { Prisma } from '../src/generated/prisma/client'
import { TransportBy } from '../src/generated/prisma/enums'
import { seedAt } from '../src/seed-calendar'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedShipping } from './shipping'

/**
 * B-OP-046 (order page plan N6, lines-derived; the Owner's D6 "from the garments"): one shipment that carries the garments of TWO
 * orders of one customer, as the order page shows it once several orders per shipment are switched on (B-OP-047).
 *
 *   SH-0004   a DRAFT shipment made for SEED-SO-0002 (its first order) at plant A1, to SEED-SO-0002's ship-to, carrying
 *             SEED-SO-0002's last released BLK 52 (WO-0001) and SEED-SO-0003's last released serial-tracked jacket (WO-0003):
 *             lines of two open orders of P1, of company A, in EUR and IT_B2B (the line guard's rule, schema wave
 *             "order page 1/1"). No join row: a shipment's orders are the orders of its lines (Shipment.salesOrderId stays
 *             the first). Nothing packed yet (a serial is packed before PACKED).
 *
 * It runs after the shipping seed (which it runs itself, idempotent) and takes the two garments that seed leaves released and
 * on no shipment; no other seed puts those two cells on a shipment. Only a database seeded with EVERY seed file (the CLI, and
 * the suites that seed all files) gains it; a suite that imports seed/shipping alone keeps its counts.
 *
 * Not seeded here (B-OP-022's monthly invoice of two orders, an ISSUED TD24 partly paid): an issued TD24 needs every GOODS line
 * on a DDT of a shipment that left, i.e. a packed, DDT'd, shipped shipment through the shipping, quality, numbering and money
 * guards; it is built by the money tests' own fixture (from-shipment.pg) and the order page's end walk instead.
 *
 * Every name, number and value is invented. Idempotent: skipped when the shipment exists. Its ids sort last ("ffffffff…"): the
 * generated isolation tests copy the FIRST row of each table, and a copy of these lines would pass their cells' releases.
 */

const T = {
  planned: seedAt('2026-11-26T08:00:00.000Z'),
} as const

export interface OrderPageSeed {
  /** SEED-SH-0004: a DRAFT of SEED-SO-0002 (first) carrying a line of SEED-SO-0003 too. */
  readonly sharedShipmentId: string
  /** Its lines: SEED-SO-0002's BLK 52, then SEED-SO-0003's jacket. */
  readonly lineIds: readonly [string, string]
  readonly salesOrderIds: readonly [string, string]
}

export async function seed(context: SeedContext): Promise<OrderPageSeed> {
  const { db, namespace } = context
  const shipping = await seedShipping(context)
  const { quality } = shipping
  const { production } = quality
  const id = (key: string): string => seedUuid(namespace, key)
  const lateId = (key: string): string => `ffffffff${id(key).slice(8)}`
  const tenantId = id('tenant')
  const actorId = id('actor')
  const companyA = id('company:A')
  const siteA = id('site:A1')
  const brandId = id('party:P1')
  const office = { audience: 'office' as const, tenantId, actorId }
  const select = { id: true } as const

  const result: OrderPageSeed = {
    sharedShipmentId: lateId('order-page:shipment:SH-0004'),
    lineIds: [lateId('order-page:SH-0004:line:BLK-52'), lateId('order-page:SH-0004:line:JKT-03')],
    salesOrderIds: [production.salesOrderId, quality.serialSalesOrderId],
  }
  if (await db.withScope(office, (client) => client.shipment.findUnique({ where: { id: result.sharedShipmentId }, select }))) return result

  const stamp = { createdAt: T.planned, updatedAt: T.planned, createdById: actorId }
  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: production.salesOrderId }, select: { shipTo: true } })
      const blk = await tx.workOrderSize.findUniqueOrThrow({ where: { id: production.cellIds['BLK-52'] }, select: { workOrderId: true, salesOrderLineId: true, size: true } })
      const jacket = await tx.workOrderSize.findUniqueOrThrow({ where: { id: quality.serialCellId }, select: { workOrderId: true, salesOrderLineId: true, size: true } })
      await tx.shipment.create({
        data: {
          id: result.sharedShipmentId,
          companyId: companyA,
          siteId: siteA,
          partyId: brandId,
          salesOrderId: production.salesOrderId,
          number: 'SEED-SH-0004',
          shipTo: (order.shipTo ?? {}) as Prisma.InputJsonValue,
          transportBy: TransportBy.CARRIER,
          carrierCode: 'seed-express',
          carrierName: 'Seed Express',
          serviceCode: 'seed-standard',
          ...stamp,
        },
        select,
      })
      for (const [index, cell, cellId] of [
        [0, blk, production.cellIds['BLK-52']],
        [1, jacket, quality.serialCellId],
      ] as const) {
        await tx.shipmentLine.create({
          data: { id: result.lineIds[index], siteId: siteA, partyId: brandId, shipmentId: result.sharedShipmentId, workOrderId: cell.workOrderId, workOrderSizeId: cellId, salesOrderLineId: cell.salesOrderLineId!, size: cell.size, quantity: 1, ...stamp },
          select,
        })
      }
    }),
  )
  return result
}
