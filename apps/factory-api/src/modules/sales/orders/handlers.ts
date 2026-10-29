import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { followOrder, noteSettlementLost } from './moves'

/**
 * The worker's handlers that keep a sales order's state with its facts (B-W1-25; SAL-204: the system is the one writer of
 * these moves), each as the system of the event's tenant (background.ts HANDLERS). They move on facts read again under
 * the order's lock (moves.ts `followOrder`), never on the event alone, so a repeat or a late event changes nothing.
 *
 *   sales.ordersFollowWorkOrders   workorder.released: the work order's orders start production (the release itself
 *                                  never moves an order: B-W1-38 leaves it to sales)
 *   sales.ordersFollowShipments    shipment.status_changed to SHIPPED, DELIVERED or RETURNED: the shipped quantities
 *                                  (PARTLY_SHIPPED, SHIPPED; back to PARTLY_SHIPPED when a shipment came back)
 *   sales.ordersFollowSettlement   order.fully_settled (B-W1-51, the money module): a SHIPPED order closes (the close
 *                                  command's guard asks the settlement port again); order.unsettled: a CLOSED order's
 *                                  history says so (a closed order never changes)
 */

const SHIPPED_MOVES = new Set(['SHIPPED', 'DELIVERED', 'RETURNED'])

export function orderHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'sales.ordersFollowWorkOrders',
      events: ['workorder.released'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { number?: string; salesOrderIds?: string[] }
        for (const orderId of [...new Set(payload.salesOrderIds ?? [])].sort()) {
          await followOrder(caller, orderId, { what: payload.number ? `work order ${payload.number} released` : 'a work order released', causationId: event.eventId })
        }
      },
    }),
    defineHandler({
      name: 'sales.ordersFollowShipments',
      events: ['shipment.status_changed'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { shipmentId: string; number?: string; to: string }
        if (!SHIPPED_MOVES.has(payload.to)) return
        const shipment = await caller.withClient((client) => client.shipment.findUnique({ where: { id: payload.shipmentId }, select: { salesOrderId: true } }))
        if (!shipment) return
        await followOrder(caller, shipment.salesOrderId, { what: `shipment ${payload.number ?? payload.shipmentId} ${payload.to.toLowerCase()}`, causationId: event.eventId })
      },
    }),
    defineHandler({
      name: 'sales.ordersFollowSettlement',
      // Declared by the money module (B-W1-51); consumed by name.
      events: ['order.fully_settled', 'order.unsettled'],
      attempts: 10,
      async handle(event, { caller }) {
        const payload = event.payload as { orderId: string; missing?: string[] }
        if (event.type === 'order.fully_settled') {
          await followOrder(caller, payload.orderId, { what: 'the order is settled', causationId: event.eventId })
          return
        }
        await noteSettlementLost(caller, payload.orderId, { eventId: event.eventId, missing: payload.missing ?? [] })
      },
    }),
  ]
}
