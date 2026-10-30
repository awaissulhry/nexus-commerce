import { isUuid } from '@nexus/factory-domain/core/ids'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { readyBySalesOrder } from '@nexus/factory-domain/shipping/shipments'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOn, officeContextOf } from '../access'
import { cellCounts } from '../cells'
import { looseScope } from './backorder'
import { finishedInStockByCell } from './stock'

/**
 * What is ready to ship (SCR-066; LOG-001, LOG-002, GAP-002): per sales order, each work order cell that quality
 * released and that shipments do not hold yet, i.e. its releases less their reversals less its lines on shipments
 * that are not CANCELLED. Only open orders (not CANCELLED, not CLOSED). Office only: a cell reaches the caller when its
 * grants reach its company, site and party.
 *
 * B-W2a-48 (W1's gap: the list was read whole, in memory): a page of orders at a time, chosen in SQL (the orders with a
 * cell that can still ship, by number; `cursor` = the last order of the page before), then each order's cells read and
 * checked with can() as before. Each cell also says how many of its garments its work order has in finished goods
 * (`inStock`): those leave from stock when the shipment leaves (shipments/stock.ts).
 */

export interface ReadyQuery {
  readonly siteId?: string | undefined
  readonly salesOrderId?: string | undefined
  readonly partyId?: string | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

export const READY_PAGE = 100

export async function readyToShip(caller: CommandCaller, query: ReadyQuery) {
  const context = officeContextOf(caller)
  const scope = looseScope(actorOf(context), SHIPPING_VIEW)
  const limit = query.limit ?? READY_PAGE
  if (!scope) return { orders: [], nextCursor: null }
  return caller.withClient(async (client) => {
    const cursor = query.cursor && isUuid(query.cursor) ? await client.salesOrder.findUnique({ where: { id: query.cursor }, select: { id: true, number: true } }) : null
    // The page of open orders with a cell (repair work orders aside) that can still ship, in the caller's scope (loosely:
    // each cell is checked with can() below).
    const page = await client.$queryRaw<{ id: string; number: string }[]>`
      SELECT o.id, o.number
        FROM "SalesOrder" o
       WHERE o.status::text NOT IN ('CANCELLED', 'CLOSED')
         AND (${query.salesOrderId ?? null}::uuid IS NULL OR o.id = ${query.salesOrderId ?? null}::uuid)
         AND (${query.partyId ?? null}::uuid IS NULL OR o."partyId" = ${query.partyId ?? null}::uuid)
         AND (${cursor?.number ?? null}::text IS NULL OR (o.number, o.id) > (${cursor?.number ?? ''}::text, ${cursor?.id ?? '00000000-0000-0000-0000-000000000000'}::uuid))
         AND EXISTS (
           SELECT 1
             FROM "WorkOrderSize" c
             JOIN "SalesOrderLine" l ON l.id = c."salesOrderLineId"
             JOIN "WorkOrder" w ON w.id = c."workOrderId"
            WHERE l."orderId" = o.id
              AND w.kind::text <> 'REPAIR'
              AND (${query.siteId ?? null}::uuid IS NULL OR c."siteId" = ${query.siteId ?? null}::uuid)
              AND (${scope.companies === null}::boolean OR w."companyId" = ANY(${scope.companies ?? []}::uuid[]))
              AND (${scope.sites === null}::boolean OR c."siteId" = ANY(${scope.sites ?? []}::uuid[]))
              AND (${scope.parties === null}::boolean OR c."partyId" = ANY(${scope.parties ?? []}::uuid[]))
              AND COALESCE((SELECT SUM(q.quantity) FROM "QualityRelease" q WHERE q."workOrderSizeId" = c.id), 0)
                - COALESCE((SELECT SUM(r.quantity) FROM "QualityReleaseReversal" r WHERE r."workOrderSizeId" = c.id), 0)
                - COALESCE((SELECT SUM(sl.quantity) FROM "ShipmentLine" sl JOIN "Shipment" s ON s.id = sl."shipmentId" WHERE sl."workOrderSizeId" = c.id AND s.status::text <> 'CANCELLED'), 0) > 0)
       ORDER BY o.number, o.id
       LIMIT ${limit + 1}`
    const orderIds = page.slice(0, limit).map((row) => row.id)
    const nextCursor = page.length > limit ? orderIds[orderIds.length - 1]! : null
    if (orderIds.length === 0) return { orders: [], nextCursor }
    // One query after another: a scoped client's transaction has one connection.
    const cells = await client.workOrderSize.findMany({
      // B-W2a-12: a repaired garment goes back with its repair's DDT (B-W2a-17), never on a shipment of the order.
      where: { salesOrderLine: { orderId: { in: orderIds } }, workOrder: { kind: { not: 'REPAIR' } }, ...(query.siteId ? { siteId: query.siteId } : {}) },
      select: {
        id: true,
        siteId: true,
        partyId: true,
        size: true,
        quantity: true,
        colourwayId: true,
        salesOrderLineId: true,
        colourway: { select: { code: true, name: true } },
        workOrder: { select: { id: true, number: true, batchNumber: true, companyId: true, styleId: true, style: { select: { code: true, name: true, garmentTracking: true } } } },
        salesOrderLine: { select: { seq: true, order: { select: { id: true, number: true, customerRef: true, status: true, companyId: true, partyId: true, party: { select: { code: true, legalName: true } } } } } },
      },
    })
    const visible = cells
      .filter((cell) => mayOn(context, SHIPPING_VIEW, { companyId: cell.workOrder.companyId, siteId: cell.siteId, partyId: cell.partyId }))
      .sort(
        (a, b) =>
          a.salesOrderLine.order.number.localeCompare(b.salesOrderLine.order.number) ||
          a.salesOrderLine.order.id.localeCompare(b.salesOrderLine.order.id) ||
          a.salesOrderLine.seq - b.salesOrderLine.seq ||
          a.workOrder.number.localeCompare(b.workOrder.number) ||
          a.colourway.code.localeCompare(b.colourway.code) ||
          a.size.localeCompare(b.size, undefined, { numeric: true }),
      )
    const counts = await cellCounts(client, visible.map((cell) => cell.id))
    const inStock = await finishedInStockByCell(
      client,
      visible.map((cell) => ({ cellId: cell.id, workOrderId: cell.workOrder.id, styleId: cell.workOrder.styleId, colourwayId: cell.colourwayId, size: cell.size })),
    )
    const groups = readyBySalesOrder(visible.map((cell) => ({ ...cell, workOrderSizeId: cell.id, salesOrderId: cell.salesOrderLine.order.id, ...counts.get(cell.id)! })))
    return {
      orders: groups.map((group) => {
        const order = group.cells[0]!.salesOrderLine.order
        return {
          salesOrderId: order.id,
          number: order.number,
          customerRef: order.customerRef,
          status: order.status,
          companyId: order.companyId,
          partyId: order.partyId,
          party: order.party,
          cells: group.cells.map((cell) => ({
            workOrderSizeId: cell.id,
            workOrderId: cell.workOrder.id,
            workOrderNumber: cell.workOrder.number,
            batchNumber: cell.workOrder.batchNumber,
            siteId: cell.siteId,
            salesOrderLineId: cell.salesOrderLineId,
            lineSeq: cell.salesOrderLine.seq,
            styleCode: cell.workOrder.style.code,
            styleName: cell.workOrder.style.name,
            colourwayCode: cell.colourway.code,
            colourwayName: cell.colourway.name,
            size: cell.size,
            pieces: cell.quantity,
            released: cell.released,
            reversed: cell.reversed,
            onShipments: cell.onShipments,
            shippable: cell.shippable,
            inStock: Math.min(inStock.get(cell.id) ?? 0, cell.shippable),
            serialTracked: cell.workOrder.style.garmentTracking === 'SERIAL',
          })),
        }
      }),
      nextCursor,
    }
  })
}
