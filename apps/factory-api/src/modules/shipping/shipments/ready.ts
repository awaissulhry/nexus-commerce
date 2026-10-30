import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { readyBySalesOrder } from '@nexus/factory-domain/shipping/shipments'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayOn, officeContextOf } from '../access'
import { cellCounts } from '../cells'

/**
 * What is ready to ship (SCR-066; LOG-001, LOG-002, GAP-002): per sales order, each work order cell that quality
 * released and that shipments do not hold yet, i.e. its releases less their reversals less its lines on shipments
 * that are not CANCELLED. Only open orders (not CANCELLED, not CLOSED). Office only: a cell reaches the caller when its
 * grants reach its company, site and party.
 */

export interface ReadyQuery {
  readonly siteId?: string | undefined
  readonly salesOrderId?: string | undefined
  readonly partyId?: string | undefined
}

export async function readyToShip(caller: CommandCaller, query: ReadyQuery) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (client) => {
    const released = await client.qualityRelease.groupBy({
      by: ['workOrderSizeId'],
      where: {
        AND: [
          scopeWhere(actor, SHIPPING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.QualityReleaseWhereInput,
          query.siteId ? { siteId: query.siteId } : {},
          query.salesOrderId || query.partyId
            ? { workOrderSize: { ...(query.partyId ? { partyId: query.partyId } : {}), ...(query.salesOrderId ? { salesOrderLine: { orderId: query.salesOrderId } } : {}) } }
            : {},
        ],
      },
    })
    const cellIds = released.map((row) => row.workOrderSizeId)
    if (cellIds.length === 0) return { orders: [] }
    const [counts, cells] = await Promise.all([
      cellCounts(client, cellIds),
      client.workOrderSize.findMany({
        // B-W2a-12: a repaired garment goes back with its repair's DDT (B-W2a-17), never on a shipment of the order.
        where: { id: { in: cellIds }, salesOrderLine: { order: { status: { notIn: ['CANCELLED', 'CLOSED'] } } }, workOrder: { kind: { not: 'REPAIR' } } },
        select: {
          id: true,
          siteId: true,
          partyId: true,
          size: true,
          quantity: true,
          salesOrderLineId: true,
          colourway: { select: { code: true, name: true } },
          workOrder: { select: { id: true, number: true, batchNumber: true, companyId: true, style: { select: { code: true, name: true, garmentTracking: true } } } },
          salesOrderLine: { select: { seq: true, order: { select: { id: true, number: true, customerRef: true, status: true, companyId: true, partyId: true, party: { select: { code: true, legalName: true } } } } } },
        },
      }),
    ])
    const visible = cells
      .filter((cell) => mayOn(context, SHIPPING_VIEW, { companyId: cell.workOrder.companyId, siteId: cell.siteId, partyId: cell.partyId }))
      .sort(
        (a, b) =>
          a.salesOrderLine.order.number.localeCompare(b.salesOrderLine.order.number) ||
          a.salesOrderLine.seq - b.salesOrderLine.seq ||
          a.workOrder.number.localeCompare(b.workOrder.number) ||
          a.colourway.code.localeCompare(b.colourway.code) ||
          a.size.localeCompare(b.size, undefined, { numeric: true }),
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
            serialTracked: cell.workOrder.style.garmentTracking === 'SERIAL',
          })),
        }
      }),
    }
  })
}
